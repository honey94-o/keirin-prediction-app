"""既存レースの結果ページ(raceresult)を再取得し、odds.ninki（3連単の的中
組み合わせが何番人気だったか）を埋める一回限りのバックフィルスクリプト。

WINTICKETの結果ページの払戻金テーブルには「人気」列（例:"(3)"）が既にあり、
これまではodds_value（払戻額）だけ取得してninki列は保存していなかった。
着順・出走表（entries）は不要で払戻金テーブルだけで完結するため、
parse_raceresultの本体は呼ばず軽量なparse_sanrentan_payoutだけを使う。

odds行自体は既存（backfill_comments.py実行時までに揃っている想定）で、
ここではUPDATEのみ行う（同じrace_id+combinationに複数行ある場合は
全部同じninkiで更新する——結果確定後の値なので何回取得しても同じ値）。

使い方:
    python backfill_ninki.py [--limit N]
"""
from __future__ import annotations

import argparse
import concurrent.futures

from bs4 import BeautifulSoup

from db import get_client
from winticket_scraper import JOCD_TO_WINTICKET_SLUG, _get, _sleep, parse_sanrentan_payout

BACKFILL_CONCURRENCY = 5


def fetch_target_races() -> list[tuple]:
    """WINTICKET由来で3連単のoddsはあるがninki未取得のレースを返す
    （id, jocd, encp）。"""
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT r.id, r.jocd, r.encp
            FROM races r
            WHERE r.encp LIKE 'wt:%'
              AND EXISTS (
                  SELECT 1 FROM odds o
                  WHERE o.race_id = r.id AND o.bet_type = '3連単' AND o.ninki IS NULL
              )
            ORDER BY r.kaisai_date, r.id
            """
        )
        return result.rows
    finally:
        client.close()


def save_ninki(race_id: int, odds: list[dict]) -> None:
    if not odds:
        return
    client = get_client()
    try:
        client.batch([
            (
                """UPDATE odds SET ninki = ?
                   WHERE race_id = ? AND bet_type = '3連単' AND combination = ?""",
                [o["ninki"], race_id, o["combination"]],
            )
            for o in odds
            if o.get("ninki") is not None
        ])
    finally:
        client.close()


def process_one(race_row: tuple) -> bool:
    race_id, jocd, encp = race_row
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

    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if len(tables) < 2:
        return False
    odds = parse_sanrentan_payout(tables[1])
    if not odds:
        return False
    save_ninki(race_id, odds)
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
