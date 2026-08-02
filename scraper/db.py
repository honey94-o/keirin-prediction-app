"""Turso（libSQL）への接続ヘルパー。

環境変数 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を読む。
ローカル実行時は .env.local を読み込む（python-dotenvがあれば）。
GitHub Actions実行時はSecretsから環境変数として渡される想定。
"""
import os
from pathlib import Path

from libsql_client import ClientSync, create_client_sync

_ENV_LOADED = False


def _load_dotenv_once() -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True
    env_path = Path(__file__).parent.parent / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def get_client() -> ClientSync:
    _load_dotenv_once()
    url = os.environ.get("TURSO_DATABASE_URL")
    auth_token = os.environ.get("TURSO_AUTH_TOKEN")
    if not url:
        raise RuntimeError(
            "TURSO_DATABASE_URL が設定されていません。.env.local を用意するか、"
            "環境変数として設定してください（README参照）。"
        )
    return create_client_sync(url=url, auth_token=auth_token)
