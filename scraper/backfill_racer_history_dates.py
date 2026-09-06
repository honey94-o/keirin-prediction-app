"""racer_race_history.race_date_full（年込みの日付）を、既存行に対して
scraped_atを基準にバックフィルする一回限りのスクリプト。

race_dateは選手プロフィールページの表示そのまま"MM/DD"で年情報が無いため、
そのままでは「このレースより後の成績」を除外する日付フィルタに使えない
（バックテストに未来の情報が混入する原因になっていた）。scraped_at
（このレース行を実際に取得した日時）を基準に、resolve_full_date関数と
同じロジック（scraped_at以前で一番近い年）で年を復元する。

厳密には「取得した日≠そのレースが最新8走に載っていた日」というズレは
あり得るが、RACER_HISTORY_MAX_AGE_DAYS=3で頻繁に更新されるため実用上は
十分近い近似になる。

1行ずつPythonでUPDATEすると52,000件規模で数時間かかる（DB往復のレイテンシが
支配的）ため、日付計算をSQL側（make_date）で行い1回のUPDATE文で済ませる。
2/29（うるう年でない年に解決されると存在しない日になる）はごく僅かな件数の
ため対象から除外し、race_date_fullはNULLのまま残す（安全側）。

使い方:
    python backfill_racer_history_dates.py
"""
from __future__ import annotations

from db import get_client

UPDATE_SQL = """
UPDATE racer_race_history
SET race_date_full = to_char(
    CASE
        WHEN make_date(
            EXTRACT(YEAR FROM scraped_at::timestamp)::int,
            split_part(race_date, '/', 1)::int,
            split_part(race_date, '/', 2)::int
        ) > scraped_at::date
        THEN make_date(
            EXTRACT(YEAR FROM scraped_at::timestamp)::int - 1,
            split_part(race_date, '/', 1)::int,
            split_part(race_date, '/', 2)::int
        )
        ELSE make_date(
            EXTRACT(YEAR FROM scraped_at::timestamp)::int,
            split_part(race_date, '/', 1)::int,
            split_part(race_date, '/', 2)::int
        )
    END,
    'YYYYMMDD'
)
WHERE race_date_full IS NULL
  AND race_date ~ '^[0-9]{1,2}/[0-9]{1,2}$'
  AND NOT (split_part(race_date, '/', 1) = '2' AND split_part(race_date, '/', 2) = '29')
"""


def main() -> None:
    client = get_client()
    try:
        result = client.execute("SELECT COUNT(*) FROM racer_race_history WHERE race_date_full IS NULL")
        before = result.rows[0][0]
        print(f"バックフィル対象: {before}件")
        if before == 0:
            return
        client.execute(UPDATE_SQL)
        result = client.execute("SELECT COUNT(*) FROM racer_race_history WHERE race_date_full IS NULL")
        after = result.rows[0][0]
        print(f"完了。解決できず残った件数（2/29等・想定外フォーマット）: {after}件")
    finally:
        client.close()


if __name__ == "__main__":
    main()
