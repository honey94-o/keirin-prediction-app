"""既存のracersテーブル（WINTICKET由来、snumが"wt"始まり）に対して、
選手プロフィールページから前期級班・直近の出走履歴を補完するバックフィル用スクリプト。

winticket_scraper.pyのレース取得フロー（scrape_one_race）でも新規選手は
自動的に補完されるが、既に取得済みのレースの選手は補完されないため、
このスクリプトで既存分をまとめて埋める。選手単位で鮮度をキャッシュするため、
再実行しても未更新の選手はスキップされ、節度あるアクセスに配慮している。

使い方:
    python backfill_racer_profiles.py
"""
from __future__ import annotations

from db import get_client
from winticket_scraper import (
    RACER_HISTORY_MAX_AGE_DAYS,
    _days_since_update,
    scrape_cyclist_history,
)


def save_enrichment(snum: str, prev_class_rank: str | None, histories) -> None:
    client = get_client()
    try:
        statements: list[tuple[str, list]] = []
        if prev_class_rank is not None:
            statements.append((
                "UPDATE racers SET prev_class_rank=?, updated_at=datetime('now') WHERE snum=?",
                [prev_class_rank, snum],
            ))
        for h in histories:
            statements.append((
                """INSERT INTO racer_race_history (snum, race_date, venue_abbr, finish_positions)
                   VALUES (?,?,?,?)
                   ON CONFLICT(snum, race_date, venue_abbr) DO UPDATE SET
                       finish_positions=excluded.finish_positions, scraped_at=datetime('now')""",
                [h.snum, h.race_date, h.venue_abbr, h.finish_positions],
            ))
        if statements:
            client.batch(statements)
    finally:
        client.close()


def main() -> None:
    client = get_client()
    try:
        result = client.execute("SELECT snum FROM racers WHERE snum LIKE 'wt%' ORDER BY snum")
        snums = [row[0] for row in result.rows]
    finally:
        client.close()

    print(f"対象選手: {len(snums)}名")
    updated = 0
    skipped = 0
    for i, snum in enumerate(snums, start=1):
        cyclist_id = snum[2:]

        class_age = _days_since_update(
            "SELECT updated_at FROM racers WHERE snum=? AND prev_class_rank IS NOT NULL",
            (snum,),
        )
        history_age = _days_since_update(
            "SELECT MAX(scraped_at) FROM racer_race_history WHERE snum=?",
            (snum,),
        )
        need_class = class_age is None
        need_history = history_age is None or history_age > RACER_HISTORY_MAX_AGE_DAYS
        if not need_class and not need_history:
            skipped += 1
            continue

        prev_class_rank, histories = scrape_cyclist_history(cyclist_id)
        save_enrichment(snum, prev_class_rank if need_class else None, histories if need_history else [])
        updated += 1

        if i % 50 == 0:
            print(f"  {i}/{len(snums)} 処理済み（更新{updated}件・スキップ{skipped}件）")

    print(f"\n完了: 更新{updated}件 / スキップ{skipped}件（既に鮮度十分）")


if __name__ == "__main__":
    main()
