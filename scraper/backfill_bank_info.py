"""全開催場のバンク特性データ（直線距離など）をKEIRIN.JPからまとめて取得し、
bank_info テーブルをバックフィルするスクリプト。

これまでkeirin_scraper.pyのscrape_bank_infoは1レース取得のついでに（該当開催場が
古くなっていれば）呼ばれる形だったため、実際にスクレイピングされたことがある
開催場しかbank_infoに入っていなかった（31開催場中5場のみ）。
races テーブルに既に記録されている全開催場のjocdに対して直接scrape_bank_infoを
呼び出し、まとめて埋める。

使い方:
    python backfill_bank_info.py            # races未登録の開催場も含め全件取得
    python backfill_bank_info.py --force     # 既存データも含め全件再取得

注意: /pc/jyoguide はKEIRIN.JPのrobots.txtで許可されているページ
（scrape_bank_infoのdocstring参照）。REQUEST_INTERVAL_SEC（2秒）は変更しないこと。
"""
from __future__ import annotations

import argparse

from playwright.sync_api import sync_playwright

from db import get_client
from keirin_scraper import USER_AGENT, scrape_bank_info


def get_known_venues(client) -> list[tuple[str, str]]:
    result = client.execute(
        "SELECT DISTINCT jocd, keirinjo_name FROM races WHERE jocd IS NOT NULL ORDER BY jocd"
    )
    return [(row[0], row[1]) for row in result.rows]


def get_existing_jocds(client) -> set[str]:
    result = client.execute("SELECT jocd FROM bank_info")
    return {row[0] for row in result.rows}


def save_bank_info(client, jocd: str, keirinjo_name: str, info) -> None:
    client.execute(
        """INSERT INTO bank_info (jocd, keirinjo_name, shuutyou, tyokusen, kant, tkant,
                                   home_hukuin, back_hukuin, center_hukuin,
                                   nige_pct, makuri_pct, sashi_pct, feature_text, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(jocd) DO UPDATE SET
               keirinjo_name=excluded.keirinjo_name, shuutyou=excluded.shuutyou,
               tyokusen=excluded.tyokusen, kant=excluded.kant, tkant=excluded.tkant,
               home_hukuin=excluded.home_hukuin, back_hukuin=excluded.back_hukuin,
               center_hukuin=excluded.center_hukuin, nige_pct=excluded.nige_pct,
               makuri_pct=excluded.makuri_pct, sashi_pct=excluded.sashi_pct,
               feature_text=excluded.feature_text, updated_at=datetime('now')""",
        [jocd, keirinjo_name, info.shuutyou, info.tyokusen, info.kant, info.tkant,
         info.home_hukuin, info.back_hukuin, info.center_hukuin,
         info.nige_pct, info.makuri_pct, info.sashi_pct, info.feature_text],
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="既存データがある開催場も再取得する")
    args = parser.parse_args()

    client = get_client()
    try:
        venues = get_known_venues(client)
        existing = set() if args.force else get_existing_jocds(client)
        targets = [(jocd, name) for jocd, name in venues if jocd not in existing]

        print(f"races テーブルの開催場: {len(venues)}件 / 未取得: {len(targets)}件")
        if not targets:
            print("取得対象なし（--force で再取得できます）")
            return

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(user_agent=USER_AGENT)
            try:
                for i, (jocd, name) in enumerate(targets, 1):
                    try:
                        info = scrape_bank_info(page, jocd)
                        save_bank_info(client, jocd, name, info)
                        print(f"[{i}/{len(targets)}] {name}({jocd}): 直線{info.tyokusen} 周長{info.shuutyou}m 保存完了")
                    except Exception as exc:  # noqa: BLE001 - 1開催場の失敗で全体を止めない
                        print(f"[{i}/{len(targets)}] {name}({jocd}): 失敗 - {exc}")
            finally:
                browser.close()
    finally:
        client.close()


if __name__ == "__main__":
    main()
