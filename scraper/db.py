"""Postgres（Neon）への接続ヘルパー。

環境変数 DATABASE_URL を読む。元はTurso（libSQL）を使っていたが支払い問題で移行した。
呼び出し側（winticket_scraper.py等）は「?プレースホルダ」「client.execute(sql, args)」
「client.batch([(sql, args), ...])」というlibsql_client（Python版）の呼び出し規約の
ままなので、ここでSQL文字列・呼び出し方を変えずに済むようpsycopg2向けアダプタを
用意する:
    - `?` → `%s`（psycopg2のプレースホルダ。ただしargsが渡された場合のみ変換する。
      argsが無い呼び出し=クエリ自体に`?`が出現しない前提で、そのままpsycopg2へ渡す。
      これは "SELECT ... LIKE 'wt%'" のようにSQL内に生の`%`を含むクエリで、
      argsを渡すと psycopg2 がそれを書式指定子として誤解釈するのを避けるため）。
    - `datetime('now')` → `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
      （SQLiteのdatetime('now')と同じ "YYYY-MM-DD HH:MM:SS" 形式の文字列を維持し、
      Python側のdatetime.fromisoformat()パース処理を変えずに済ませる）。
ローカル実行時は .env.local を読み込む（python-dotenvがあれば）。
GitHub Actions実行時はSecretsから環境変数として渡される想定。

接続はThreadedConnectionPoolで管理する（以前は単一のグローバル接続を使い回し、
close()を実質no-opにしていた——psycopg2.connect()の毎回のTCP+TLSハンドシェイクが
1レースあたり数十回のDB往復で無視できないコストだったため）。winticket_scraper.py
の全開催場スキャンを開催場単位で並列化するにあたり、単一コネクションを複数スレッドが
同時にcursor操作するとプロトコルが壊れるため、スレッドごとに別コネクションが要る。
プールならgetconn/putconnは（connect()と違い）ハンドシェイクを伴わないため、
両方の問題（再接続コスト・スレッド安全性）を同時に解決できる。
"""
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Sequence, TypeVar

import psycopg2
import psycopg2.extras
import psycopg2.pool

_ENV_LOADED = False

_RETRYABLE_PATTERN = re.compile(r"50\d|ECONNRESET|ETIMEDOUT|timeout|server closed the connection", re.IGNORECASE)
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
        os.environ.setdefault(key.strip(), value.strip().strip('"'))


def _translate_dialect(sql: str) -> str:
    return sql.replace("datetime('now')", "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')")


class ExecuteResult:
    def __init__(self, rows: list[tuple]):
        self.rows = rows


class PgClient:
    """libsql_client.ClientSyncと同じ呼び出し規約（execute/batch/close）を持つラッパー。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql: str, args: Sequence[Any] | None = None) -> ExecuteResult:
        text = _translate_dialect(sql)
        with self._conn.cursor() as cur:
            if args is None:
                _with_retry(cur.execute)(text)
            else:
                text = text.replace("?", "%s")
                _with_retry(cur.execute)(text, list(args))
            try:
                rows = cur.fetchall()
            except psycopg2.ProgrammingError:
                rows = []  # SELECT/RETURNINGを伴わない文（INSERT/UPDATE単体等）
        return ExecuteResult(rows)

    def batch(self, statements: list[tuple[str, Sequence[Any]]]) -> None:
        with self._conn.cursor() as cur:
            for sql, args in statements:
                text = _translate_dialect(sql).replace("?", "%s")
                _with_retry(cur.execute)(text, list(args))

    def close(self) -> None:
        # プールへ返却する（接続自体は切らない。呼び出し側は引き続き
        # 「1回のDB操作のまとまり毎にget_client()→...→client.close()」の
        # パターンのままでよい——putconnはgetconnと対で、ハンドシェイクを伴わない）。
        _get_pool().putconn(self._conn)


_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    _load_dotenv_once()
    if _pool is None:
        url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL が設定されていません。.env.local を用意するか、"
                "環境変数として設定してください（README参照）。"
            )
        # maxconnは開催場並列数（winticket_scraper.py --all-venuesの
        # VENUE_CONCURRENCY）より余裕を持たせる。1スクリプトプロセス内で
        # 完結する（プロセス跨ぎでは共有しない）。
        _pool = psycopg2.pool.ThreadedConnectionPool(1, 20, url)
    return _pool


def get_client() -> PgClient:
    conn = _get_pool().getconn()
    conn.autocommit = True
    return PgClient(conn)
