"""既に着順が確定している過去レースについて、結果ページだけを再取得して
results.agari_time（上がりタイム、WINTICKETの結果ページ「上り」列）を埋める
一回限りのバックフィルスクリプト。

2日目以降のレースで「前日（同一開催内）の上がりタイム」を調子の指標として
使えるか検証するための準備。出走表(racecard)は取り直さず結果ページのみを
見るため、sync_results_only.pyと同じ軽量な作りにしている。
winticket_scraper.pyのVENUE_CONCURRENCYと同じ考え方でスレッド並列化する
（各スレッドは自分のリクエスト間隔を守ったまま独立に進む）。

使い方:
    python backfill_agari_time.py
"""
from __future__ import annotations

import argparse
import concurrent.futures

from db import get_client
from keirin_scraper import RaceData
from winticket_scraper import JOCD_TO_WINTICKET_SLUG, _get, _sleep, parse_raceresult

BACKFILL_CONCURRENCY = 5


def fetch_target_races() -> list[tuple]:
    """着順は確定済みだがagari_timeが未取得のレースを返す
    （id, jocd, keirinjo_name, race_no, kaisai_date, encp）。"""
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT r.id, r.jocd, r.keirinjo_name, r.race_no, r.kaisai_date, r.encp
            FROM races r
            WHERE r.encp IS NOT NULL
              AND EXISTS (SELECT 1 FROM results res WHERE res.race_id = r.id AND res.finish_pos IS NOT NULL)
              AND EXISTS (SELECT 1 FROM results res WHERE res.race_id = r.id AND res.agari_time IS NULL)
            ORDER BY r.kaisai_date, r.id
            """
        )
        return result.rows
    finally:
        client.close()


def fetch_entries(race_id: int) -> list[tuple]:
    client = get_client()
    try:
        result = client.execute("SELECT car_num, snum FROM entries WHERE race_id = ?", [race_id])
        return result.rows
    finally:
        client.close()


def save_results(race_id: int, results: list[dict]) -> None:
    if not results:
        return
    client = get_client()
    try:
        client.batch([
            (
                """INSERT INTO results (race_id, snum, car_num, finish_pos, kimarite, agari_time)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(race_id, car_num) DO UPDATE SET
                       finish_pos=excluded.finish_pos, kimarite=excluded.kimarite,
                       agari_time=excluded.agari_time""",
                [race_id, r["snum"], r["car_num"], r["finish_pos"], r["kimarite"], r.get("agari_time")],
            )
            for r in results
        ])
    finally:
        client.close()


def process_one(race_row: tuple) -> bool:
    race_id, jocd, keirinjo_name, race_no, kaisai_date, encp = race_row
    slug = JOCD_TO_WINTICKET_SLUG.get(jocd)
    if slug is None:
        return False
    parts = encp.split(":", 1)[1].split("/") if encp.startswith("wt:") else None
    if not parts or len(parts) != 3:
        return False
    cup_id, day, encp_race_no = parts

    status, html = _get(f"https://winticket.jp/keirin/{slug}/raceresult/{cup_id}/{day}/{encp_race_no}")
    _sleep()
    if status != 200:
        return False

    entries_rows = fetch_entries(race_id)
    race = RaceData(
        kaisai_date=kaisai_date, jocd=jocd, keirinjo_name=keirinjo_name,
        race_no=race_no, encp=encp,
    )
    race.entries = [{"car_num": car_num, "snum": snum} for car_num, snum in entries_rows]
    parse_raceresult(html, race)
    if not race.results:
        return False
    save_results(race_id, race.results)
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="動作確認用に件数を絞る")
    args = parser.parse_args()

    races = fetch_target_races()
    if args.limit:
        races = races[: args.limit]
    print(f"対象レース: {len(races)}件")

    done = 0
    failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=BACKFILL_CONCURRENCY) as executor:
        futures = {executor.submit(process_one, r): r[0] for r in races}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                ok = future.result()
                if ok:
                    done += 1
                else:
                    failed += 1
            except Exception as exc:  # noqa: BLE001 - 1件の失敗で全体を止めない
                failed += 1
                print(f"  警告: race_id={futures[future]} 失敗: {exc}")
            if i % 200 == 0:
                print(f"  {i}/{len(races)} 処理済み（成功{done}件・失敗{failed}件）")

    print(f"\n完了: 成功{done}件 / 失敗{failed}件")


if __name__ == "__main__":
    main()
