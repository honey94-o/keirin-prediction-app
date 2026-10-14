/**
 * オフライン検証用のローカルSQLiteアダプタ。
 *
 * 2026-09にpredictRaceの全件スキャンを何度も回してNeon無料枠の転送量(5GB/月)を
 * 使い切り本番が落ちた反省から、大規模バックテストは本番DBに一切アクセスせず
 * scripts/local-db/dump-to-sqlite.tsで一度だけ取り込んだローカルコピーに対して回す。
 * lib/repository.tsのSQLは元々SQLite方言で書かれているためほぼそのまま動く
 * （Postgres専用の`::float`キャストだけここで変換する）。
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setDbClientForOfflineScripts, type DbClient, type DbStatement, type ExecuteResult } from "../../lib/db";

export const LOCAL_DB_PATH = path.join(process.cwd(), "scripts", "data", "local.sqlite");

function toSqlite(sql: string): string {
  return sql.replace(/::float/g, "*1.0");
}

type SqlValue = string | number | null | bigint | Uint8Array;

function normalizeArgs(args: unknown[]): SqlValue[] {
  return args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === "boolean") return a ? 1 : 0;
    return a as SqlValue;
  });
}

export function openLocalDb(dbPath = LOCAL_DB_PATH): DatabaseSync {
  return new DatabaseSync(dbPath);
}

/** lib/db.tsのgetDb()がローカルSQLiteを返すように差し替える。 */
export function useLocalDb(dbPath = LOCAL_DB_PATH): DatabaseSync {
  const db = openLocalDb(dbPath);
  const stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const run = (stmtOrSql: string | DbStatement, maybeArgs?: unknown[]): ExecuteResult => {
    const sql = typeof stmtOrSql === "string" ? stmtOrSql : stmtOrSql.sql;
    const args = typeof stmtOrSql === "string" ? (maybeArgs ?? []) : (stmtOrSql.args ?? []);
    const text = toSqlite(sql);
    let stmt = stmtCache.get(text);
    if (!stmt) {
      stmt = db.prepare(text);
      stmtCache.set(text, stmt);
    }
    const isRead = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    if (isRead) return { rows: stmt.all(...normalizeArgs(args)) as ExecuteResult["rows"] };
    stmt.run(...normalizeArgs(args));
    return { rows: [] };
  };
  const client: DbClient = {
    execute: (async (stmtOrSql: string | DbStatement, args?: unknown[]) =>
      run(stmtOrSql, args)) as DbClient["execute"],
    batch: async (statements: DbStatement[]) => statements.map((s) => run(s)),
  };
  setDbClientForOfflineScripts(client);
  return db;
}
