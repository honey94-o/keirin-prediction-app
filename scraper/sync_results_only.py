"""発走時刻を過ぎたのにまだ着順が確定していないレースだけ、WINTICKETの結果ページを
直接見に行って結果・払戻を反映する軽量スクリプト。

winticket_scraper.py --all-venues は出走表から辿り直すため時間がかかり、
日中にレースが終わってからホーム画面の「終了」表示に反映されるまで数時間ラグが
あった（次の定期実行=daily-sync.ymlを待つしかなかったため）。このスクリプトは
既にDBにある本日のレース・出走（entries）情報をそのまま使い、結果ページへの
GET1回だけで済ませるため数十秒〜数分で終わる。GitHub Actions（results-sync.yml）
から15分おきに実行する想定。

DB書き込みはresults/oddsのみに限定する。racers/entriesは一切触らない
（winticket_scraper.pyのsave_to_dbをそのまま使うと、ここでは取得しないracersの
詳細項目がNULLで上書きされてしまうため、専用の最小限upsertをここに用意する）。

対象は「JST当日」のレースのみ（ミッドナイト開催が翌日に日付が変わって終わる
ケースは考慮しない。次のdaily-sync.yml実行で従来通り拾われる）。
"""
from __future__ import annotations

import datetime
import re
import time

from db import get_client
from keirin_scraper import RaceData
from winticket_scraper import JOCD_TO_WINTICKET_SLUG, _get, _sleep, parse_raceresult

ENCP_RE = re.compile(r"^wt:(\d{10})/(\d+)/(\d+)$")

# WINTICKET側は着順確定から結果ページへの反映まで数分ラグがあることがある。
# 発走時刻を過ぎているのに結果がまだ載っていないレースを、次回cron（15分後）を
# 待たずに同じ実行内で数分おきに数回リトライする。
MAX_ROUNDS = 3
ROUND_WAIT_SEC = 90


def parse_encp(encp: str | None) -> tuple[str, int, int] | None:
    if not encp:
        return None
    m = ENCP_RE.match(encp)
    if not m:
        return None
    return m.group(1), int(m.group(2)), int(m.group(3))


def _jst_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)


def now_jst_hhmm() -> str:
    return _jst_now().strftime("%H:%M")


def today_jst_str() -> str:
    return _jst_now().strftime("%Y%m%d")


def fetch_unfinished_races(kaisai_date: str) -> list[tuple]:
    """指定日（YYYYMMDD）で着順(finish_pos)が3件未満のレースを返す
    （id, jocd, keirinjo_name, race_no, encp, start_time）。"""
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT r.id, r.jocd, r.keirinjo_name, r.race_no, r.encp, r.start_time
            FROM races r
            WHERE r.kaisai_date = ?
              AND r.encp IS NOT NULL
              AND (SELECT COUNT(*) FROM results res
                   WHERE res.race_id = r.id AND res.finish_pos IS NOT NULL) < 3
            ORDER BY r.start_time
            """,
            [kaisai_date],
        )
    finally:
        client.close()
    return result.rows


def fetch_entries(race_id: int) -> list[tuple]:
    client = get_client()
    try:
        result = client.execute("SELECT car_num, snum FROM entries WHERE race_id = ?", [race_id])
    finally:
        client.close()
    return result.rows


def save_results_and_odds(race_id: int, results: list[dict], odds: list[dict]) -> None:
    client = get_client()
    statements: list[tuple[str, list]] = []
    for r in results:
        statements.append((
            """INSERT INTO results (race_id, snum, car_num, finish_pos, kimarite)
               VALUES (?,?,?,?,?)
               ON CONFLICT(race_id, car_num) DO UPDATE SET
                   finish_pos=excluded.finish_pos, kimarite=excluded.kimarite""",
            [race_id, r["snum"], r["car_num"], r["finish_pos"], r["kimarite"]],
        ))
    for o in odds:
        statements.append((
            """INSERT INTO odds (race_id, bet_type, combination, odds_value)
               VALUES (?,?,?,?)""",
            [race_id, o["bet_type"], o["combination"], o["odds_value"]],
        ))
    try:
        if statements:
            client.batch(statements)
    finally:
        client.close()


def check_due_races(kaisai_date: str) -> tuple[int, int]:
    """発走時刻を過ぎていて着順未確定のレースを1回ぶんチェックする。戻り値は(checked, saved)。"""
    now_hhmm = now_jst_hhmm()
    races = fetch_unfinished_races(kaisai_date)
    due = [r for r in races if r[5] and r[5] <= now_hhmm]

    checked = 0
    saved = 0
    for race_id, jocd, keirinjo_name, race_no, encp, _start_time in due:
        slug = JOCD_TO_WINTICKET_SLUG.get(jocd)
        if slug is None:
            continue  # スラッグ未判明の場（winticket_scraper.py参照）
        parsed = parse_encp(encp)
        if parsed is None:
            continue
        cup_id, day, encp_race_no = parsed
        checked += 1

        status, html = _get(
            f"https://winticket.jp/keirin/{slug}/raceresult/{cup_id}/{day}/{encp_race_no}"
        )
        _sleep()
        if status != 200:
            continue

        entries_rows = fetch_entries(race_id)
        race = RaceData(
            kaisai_date=kaisai_date, jocd=jocd, keirinjo_name=keirinjo_name,
            race_no=race_no, encp=encp,
        )
        race.entries = [{"car_num": car_num, "snum": snum} for car_num, snum in entries_rows]

        parse_raceresult(html, race)
        finished_count = sum(1 for r in race.results if r["finish_pos"] is not None)
        if finished_count < 3:
            # 発走時刻は過ぎているがWINTICKET側の結果反映がまだ（数分ラグがある）。
            # このラウンドでは保存せず、次のラウンド（または次回cron）で再チェックする。
            continue

        save_results_and_odds(race_id, race.results, race.odds)
        saved += 1
        print(f"  結果反映: {keirinjo_name} {race_no}R ({finished_count}着分、オッズ{len(race.odds)}件)")

    return checked, saved


def main() -> None:
    kaisai_date = today_jst_str()

    for round_no in range(1, MAX_ROUNDS + 1):
        checked, saved = check_due_races(kaisai_date)
        print(f"[{round_no}/{MAX_ROUNDS}] 発走済みで着順未確定のレース{checked}件中 {saved}件を反映")
        if checked == 0 or checked == saved:
            break  # 見に行くべきレースが無い/全部反映できた
        if round_no < MAX_ROUNDS:
            # 反映しきれなかった分（結果ページ側のラグ）を数分待って再チェックする。
            time.sleep(ROUND_WAIT_SEC)


if __name__ == "__main__":
    main()
