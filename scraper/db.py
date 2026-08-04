"""Turso（libSQL）への接続ヘルパー。

環境変数 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を読む。
ローカル実行時は .env.local を読み込む（python-dotenvがあれば）。
GitHub Actions実行時はSecretsから環境変数として渡される想定。
"""
import os
import re
import time
from pathlib import Path
from typing import Callable, TypeVar

from libsql_client import ClientSync, create_client_sync

_ENV_LOADED = False

# Turso（Hrana HTTP）は大量の連続クエリを投げると稀に一時的な502等を返すことがある。
# スクレイパーが長時間実行の途中でクラッシュするのを防ぐため、一時的なエラーに
# 限って数回リトライする（TypeScript側のlib/db.tsと同じ方針）。
_RETRYABLE_PATTERN = re.compile(r"50\d|ECONNRESET|ETIMEDOUT|timeout", re.IGNORECASE)
_MAX_RETRIES = 5
_RETRY_DELAY_SEC = 1.0

_T = TypeVar("_T")


def _with_retry(fn: Callable[..., _T]) -> Callable[..., _T]:
    def wrapper(*args, **kwargs):
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                return fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - 一時的なエラーかを文字列で判定するため広く捕まえる
                last_exc = exc
                if attempt == _MAX_RETRIES or not _RETRYABLE_PATTERN.search(str(exc)):
                    raise
                time.sleep(_RETRY_DELAY_SEC * (attempt + 1))
        raise last_exc  # pragma: no cover - ループを抜けたら必ずraise済み

    return wrapper


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
    # Python版libsql-client(0.3.1)はlibsql://（WebSocket/Hrana）だと
    # 環境によってハンドシェイクに失敗することがあるため、HTTP経由に変える。
    # TypeScript側(@libsql/client)はlibsql://のままで問題ないのでURL自体は変更しない。
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://"):]
    client = create_client_sync(url=url, auth_token=auth_token)
    client.execute = _with_retry(client.execute)
    client.batch = _with_retry(client.batch)
    return client
