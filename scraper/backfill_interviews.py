"""既存レースの出走表(racecard)を再取得し、racer_interviews（前検日インタビュー）
を埋める一回限りのバックフィルスクリプト。backfill_comments.pyと同じ考え方・
同じ対象HTMLを使うが、抽出対象が異なる（entries.pre_race_commentの一言では
なく、記者の質問に対する文章での回答）ため別スクリプトにしている。

同一の出走表ページを2回取得することになるが、既存のbackfill_comments.pyと
同時に走らせると本番DBのコネクションプールを圧迫した実績があるため、
必ず時間をずらして単独で実行すること。

使い方:
    python backfill_interviews.py [--limit N]
"""
from __future__ import annotations

import argparse
import concurrent.futures

from db import get_client
from winticket_scraper import JOCD_TO_WINTICKET_SLUG, _get, _sleep, parse_interviews

BACKFILL_CONCURRENCY = 5


def fetch_target_races() -> list[tuple]:
    """WINTICKET由来でインタビューが未取得のレースを返す
    （id, jocd, keirinjo_name, race_no, kaisai_date, encp）。"""
    client = get_client()
    try:
        result = client.execute(
            """
            SELECT r.id, r.jocd, r.keirinjo_name, r.race_no, r.kaisai_date, r.encp
            FROM races r
            WHERE r.encp LIKE 'wt:%'
              AND NOT EXISTS (
                  SELECT 1 FROM racer_interviews ri WHERE ri.race_id = r.id
              )
            ORDER BY r.kaisai_date, r.id
            """
        )
        return result.rows
    finally:
        client.close()


def save_interviews(race_id: int, interviews: list[dict]) -> None:
    if not interviews:
        return
    client = get_client()
    try:
        client.batch([
            (
                """INSERT INTO racer_interviews (race_id, snum, question, answer)
                   VALUES (?,?,?,?)
                   ON CONFLICT(race_id, snum, question) DO UPDATE SET
                       answer=excluded.answer""",
                [race_id, iv["snum"], iv.get("question"), iv["answer"]],
            )
            for iv in interviews
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

    interviews = parse_interviews(html)
    # インタビューが無いレース（前検日前に取得された等）もあり得るため、
    # 0件そのものは失敗として扱わない。ページ取得自体が成功していればOK。
    save_interviews(race_id, interviews)
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
