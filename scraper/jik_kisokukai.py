"""日本競輪選手養成所（JIK）の記録会データ（PDF）を取得し、racersテーブルに保存する。

競輪学校の新人候補生は、デビュー前に200m/400m/1000m/3000mのタイムトライアルを
含む「記録会」を受け、能力別（S/A/B/C/D）の評価を受ける。新人選手はレース実績が
無い/少ないため、通常のスコアリング（脚質・決まり手回数など）がほぼ機能しない。
この記録会データを取得しておくことで、新人選手の実力を測る参考指標として
将来スコアリングに組み込める可能性がある（現時点ではデータ取得のみ。
組み込みには真の勝率との相関を診断してから判断すること）。

PDFは日本競輪選手養成所サイト（https://keirin-jik.jp/）の記録会記事に掲載される
「全候補生記録」PDFへの直接リンクから取得する。期・回によってURLが変わるため、
実行のたびにURLを指定する（--url引数）。

個人利用・低頻度実行を前提とする。年に数回（記録会のたびに新しいPDFが公開された時）
手動実行する想定。

使い方:
    python jik_kisokukai.py --url "https://keirin-jik.jp/wp-content/uploads/.../xxx.pdf" --class-name "129期"
"""
from __future__ import annotations

import argparse
import re
import urllib.request
from typing import Any

import pdfplumber

from db import get_client

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def download_pdf(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def parse_time_to_sec(raw: str | None) -> float | None:
    """「11″20」→11.20、「1′09″21」→69.21 の形式を秒(float)に変換する。"""
    if not raw or raw.strip() in ("", "-"):
        return None
    raw = raw.strip()
    m = re.match(r"(?:(\d+)′)?(\d+)″(\d+)", raw)
    if not m:
        return None
    minutes = int(m.group(1)) if m.group(1) else 0
    seconds = int(m.group(2))
    hundredths = int(m.group(3))
    return minutes * 60 + seconds + hundredths / 100


def parse_pdf(pdf_bytes: bytes) -> list[dict[str, Any]]:
    """PDFの各ページの表を読み取り、候補生ごとのレコードのリストを返す。"""
    import io

    records: list[dict[str, Any]] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            for row in page.extract_tables()[0] if page.extract_tables() else []:
                # ヘッダ行（番号列が数字でない）はスキップ
                if not row or not row[0] or not row[0].strip().isdigit():
                    continue
                name = (row[1] or "").strip().lstrip("*").replace("　", " ")
                if not name:
                    continue
                records.append({
                    "name": name,
                    "age": int(row[2]) if row[2] and row[2].strip().isdigit() else None,
                    "pref": (row[3] or "").strip() or None,
                    "tt200_sec": parse_time_to_sec(row[4]),
                    "tt400_sec": parse_time_to_sec(row[6]),
                    "tt1000_sec": parse_time_to_sec(row[8]),
                    "tt3000_sec": parse_time_to_sec(row[10]),
                    "grade": (row[16] or "").strip() or None if len(row) > 16 else None,
                })
    return records


def save_to_db(records: list[dict[str, Any]], class_name: str) -> tuple[int, list[str]]:
    """氏名（空白除去）でracersテーブルと突き合わせてUPDATEする。既存の記録会データが
    無い選手だけを対象にする（COALESCE的な考え方。手動で複数回記録会を取り込む場合、
    後の回で上書きしたい時はracers側の値を先にNULLに戻してから実行すること）。
    """
    client = get_client()
    matched = 0
    unmatched: list[str] = []
    try:
        for r in records:
            normalized = r["name"].replace(" ", "").replace("　", "")
            result = client.execute(
                "SELECT snum FROM racers WHERE REPLACE(REPLACE(name, ' ', ''), '　', '') = ?",
                [normalized],
            )
            rows = result.rows
            if not rows:
                unmatched.append(r["name"])
                continue
            for row in rows:
                snum = row[0]
                client.execute(
                    """UPDATE racers SET
                           debut_class = ?, tt200_sec = ?, tt400_sec = ?,
                           tt1000_sec = ?, tt3000_sec = ?, kisokukai_grade = ?
                       WHERE snum = ?""",
                    [class_name, r["tt200_sec"], r["tt400_sec"], r["tt1000_sec"],
                     r["tt3000_sec"], r["grade"], snum],
                )
                matched += 1
    finally:
        client.close()
    return matched, unmatched


def main() -> None:
    parser = argparse.ArgumentParser(description="JIK記録会PDFを取得しracersテーブルに保存")
    parser.add_argument("--url", required=True, help="記録会PDFの直接URL")
    parser.add_argument("--class-name", required=True, help="期（例: 129期）")
    args = parser.parse_args()

    print(f"PDFを取得中: {args.url}")
    pdf_bytes = download_pdf(args.url)
    records = parse_pdf(pdf_bytes)
    print(f"候補生 {len(records)}名分のレコードを抽出しました")

    matched, unmatched = save_to_db(records, args.class_name)
    print(f"racersテーブルに一致: {matched}名")
    if unmatched:
        print(f"未一致（まだデビューしていない等）: {len(unmatched)}名")
        for name in unmatched:
            print(f"  - {name}")


if __name__ == "__main__":
    main()
