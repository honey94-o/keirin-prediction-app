"""Turso（libSQL）上にスキーマを作成する。

使い方:
    python db/init_db.py
（事前に .env.local または環境変数で TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を設定しておくこと）
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scraper"))
from db import get_client  # noqa: E402

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def _split_statements(script: str) -> list[str]:
    """schema.sqlをセミコロン区切りの個別ステートメントに分割する。
    libSQLのexecuteは複数ステートメントの一括実行(executescript相当)に対応していないため。
    """
    statements = []
    for raw in script.split(";"):
        stmt = raw.strip()
        if stmt:
            statements.append(stmt)
    return statements


def init_db() -> None:
    client = get_client()
    try:
        for stmt in _split_statements(SCHEMA_PATH.read_text(encoding="utf-8")):
            client.execute(stmt)
    finally:
        client.close()
    print("Turso DB のスキーマ初期化が完了しました")


if __name__ == "__main__":
    init_db()
