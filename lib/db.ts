import { Pool, type PoolClient } from "pg";

// 元はTurso（libSQL）を使っていたが支払い問題で移行。呼び出し側（lib/repository.ts・
// scripts/配下・scraper/db.py）は「?プレースホルダ」「datetime('now')」を使う
// SQLite方言のSQL文字列をそのまま書いているため、クエリ文字列を書き換えずに済むよう
// ここでPostgres（Neon）向けに変換するアダプタを用意する。
//   - `?` → `$1,$2,...`（位置引数プレースホルダ）
//   - `datetime('now')` → `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`（同じ文字列形式を維持）
// これにより@libsql/clientのClient型（.execute/.batch）と同じ形のインターフェースを
// 提供し、呼び出し側の変更を最小限にしている。

export interface DbRow {
  [column: string]: unknown;
}

export interface ExecuteResult {
  rows: DbRow[];
}

export interface DbStatement {
  sql: string;
  args?: unknown[];
}

export interface DbClient {
  execute(sql: string): Promise<ExecuteResult>;
  execute(sql: string, args: unknown[]): Promise<ExecuteResult>;
  execute(stmt: DbStatement): Promise<ExecuteResult>;
  batch(statements: DbStatement[]): Promise<ExecuteResult[]>;
}

const RETRYABLE_PATTERN = /50\d|ECONNRESET|ETIMEDOUT|Connection terminated|timeout/i;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES || !RETRYABLE_PATTERN.test(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

/** SQLite方言のdatetime('now')をPostgres相当の同一書式文字列に変換する。 */
function translateDialect(sql: string): string {
  return sql.replaceAll("datetime('now')", "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')");
}

/** `?`プレースホルダを出現順にPostgresの`$1,$2,...`へ変換する。 */
function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql: string): string {
  return convertPlaceholders(translateDialect(sql));
}

let pool: Pool | null = null;

// scripts/配下の各スクリプトは独自の簡易dotenvローダーをそれぞれ持っており、
// 値を "..." で囲んだままprocess.envに入れてしまうものがある（vercel envが
// .env.localに書き出す形式はダブルクォート付き）。ここで一箇所だけ対策しておけば
// 個々のスクリプトのローダーを直して回らずに済む。
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getPool(): Pool {
  if (!pool) {
    const raw =
      process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL;
    if (!raw) {
      throw new Error(
        "DATABASE_URL is not set. Add it to .env.local (Neon connection string, see README デプロイ手順)."
      );
    }
    pool = new Pool({ connectionString: stripQuotes(raw) });
  }
  return pool;
}

async function runExecute(
  queryable: Pool | PoolClient,
  stmtOrSql: string | DbStatement,
  maybeArgs?: unknown[]
): Promise<ExecuteResult> {
  const sql = typeof stmtOrSql === "string" ? stmtOrSql : stmtOrSql.sql;
  const args = typeof stmtOrSql === "string" ? (maybeArgs ?? []) : (stmtOrSql.args ?? []);
  const text = prepare(sql);
  const result = await withRetry(() => queryable.query(text, args as unknown[]));
  return { rows: result.rows as DbRow[] };
}

let client: DbClient | null = null;

export function getDb(): DbClient {
  if (!client) {
    client = {
      execute: (stmtOrSql: string | DbStatement, args?: unknown[]) =>
        runExecute(getPool(), stmtOrSql, args),
      batch: async (statements: DbStatement[]) => {
        const conn = await getPool().connect();
        try {
          await conn.query("BEGIN");
          const results: ExecuteResult[] = [];
          for (const stmt of statements) {
            results.push(await runExecute(conn, stmt));
          }
          await conn.query("COMMIT");
          return results;
        } catch (err) {
          await conn.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          conn.release();
        }
      },
    };
  }
  return client;
}
