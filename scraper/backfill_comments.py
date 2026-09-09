"""既存レースの出走表(racecard)を再取得し、entries.pre_race_comment・
entries.gear_ratioを埋める一回限りのバックフィルスクリプト。

WINTICKETの出走表ページは、レース終了後もコメント・ギヤ倍率がそのまま
残ることを確認済み（2026年4月分の最古レースでも取得できた）。そのため
これまでの全履歴に対して遡って取得できる。

選手個々の直前コメント（「自力。」「◯◯君。」でマーク相手を名指しする等）と、
レースごとのギヤ倍率（racers.gear_ratioは常にNULLの未使用カラムで、
entries側にレース単位で持つ）が、既存のライン・脚質データでは拾えない
「その日の意図・調子」を予想に活かせないか検証するための準備。
winticket_scraper.pyのVENUE_CONCURRENCYと同じ考え方でスレッド並列化する。

使い方:
    python backfill_comments.py [--limit N]
"""
from __future__ import annotations

import argparse
import concurrent.futures

from db import get_client
from winticket_scraper import JOCD_TO_WINTICKET_SLUG, _get, _sleep, parse_racecard

BACKFILL_CONCURRENCY = 5


def fetch_target_races() -> list[tuple]:
    """WINTICKET由来でコメントが未取得のレースを返す
    （id, jocd, keirinjo_name, race_no, kaisai_date, encp）。"""
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT r.id, r.jocd, r.keirinjo_name, r.race_no, r.kaisai_date, r.encp
            FROM races r
            WHERE r.encp LIKE 'wt:%'
              AND EXISTS (
                  SELECT 1 FROM entries e
                  WHERE e.race_id = r.id AND e.pre_race_comment IS NULL
              )
            ORDER BY r.kaisai_date, r.id
            """
        )
        return result.rows
    finally:
        client.close()


def save_entries(race_id: int, entries: list[dict]) -> None:
    if not entries:
        return
    client = get_client()
    try:
        client.batch([
            (
                """UPDATE entries SET pre_race_comment = ?, gear_ratio = ?
                   WHERE race_id = ? AND car_num = ?""",
                [e.get("pre_race_comment"), e.get("gear_ratio"), race_id, e["car_num"]],
            )
            for e in entries
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

    status, html = _get(f"https://winticket.jp/keirin/{slug}/racecard/{cup_id}/{day}/{encp_race_no}")
    _sleep()
    if status != 200:
        return False

    race = parse_racecard(html, cup_id, int(day), int(encp_race_no))
    if race is None or not race.entries:
        return False
    save_entries(race_id, race.entries)
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
