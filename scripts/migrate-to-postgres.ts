import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

/**
 * db/backup/*.json（scripts/backup-db.tsで取った旧Turso DBの全データ）を、
 * 新しいNeon Postgres（.env.localのDATABASE_URL）へスキーマ作成込みで
 * 丸ごと投入する。lib/db.tsが既にPostgresアダプタになっているため、getDb()を
 * そのまま使える。idカラムも含めて丸ごと挿入し、他テーブルからのrace_id/snum参照が
 * 途切れないようにする（PostgresのSERIALは明示的なid挿入を妨げない）。
 * 挿入後はSERIAL列のシーケンスを最大id+1に合わせ直す（そうしないと次のアプリ側
 * INSERTが既存idと衝突する）。
 */

const TABLE_ORDER = [
  "racers",
  "races",
  "bank_info",
  "racer_race_history",
  "entries",
  "results",
  "odds",
  "predictions",
  "scenario_stats",
  "daily_picks",
  "settings",
];

const SERIAL_TABLES = ["races", "racer_race_history", "entries", "results", "odds", "predictions"];

const PRIMARY_KEYS: Record<string, string> = {
  racers: "snum",
  races: "id",
  bank_info: "jocd",
  racer_race_history: "id",
  entries: "id",
  results: "id",
  odds: "id",
  predictions: "id",
  scenario_stats: "label",
  daily_picks: "race_id",
  settings: "key",
};

const BATCH_SIZE = 500;

async function main() {
  const db = getDb();

  console.log("スキーマを作成中...");
  const schemaPath = path.join(process.cwd(), "db", "schema.postgres.sql");
  const schemaSql = readFileSync(schemaPath, "utf-8");
  const statements = schemaSql
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(stmt);
  }
  console.log("スキーマ作成完了。\n");

  const backupDir = path.join(process.cwd(), "db", "backup");

  for (const table of TABLE_ORDER) {
    const filePath = path.join(backupDir, `${table}.json`);
    if (!existsSync(filePath)) {
      console.log(`${table}: バックアップファイルなし、スキップ`);
      continue;
    }
    const rows = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>[];
    if (rows.length === 0) {
      console.log(`${table}: 0行、スキップ`);
      continue;
    }
    const columns = Object.keys(rows[0]);
    const pk = PRIMARY_KEYS[table];
    const updateCols = columns.filter((c) => c !== pk);
    const conflictClause =
      updateCols.length > 0
        ? `ON CONFLICT (${pk}) DO UPDATE SET ${updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(",")}`
        : `ON CONFLICT (${pk}) DO NOTHING`;
    const placeholders = columns.map(() => "?").join(",");
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders}) ${conflictClause}`;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batchRows = rows.slice(i, i + BATCH_SIZE);
      await db.batch(
        batchRows.map((row) => ({
          sql,
          args: columns.map((c) => row[c] as never),
        }))
      );
    }
    console.log(`${table}: ${rows.length}行 投入完了`);
  }

  console.log("\nSERIAL列のシーケンスを最大idに合わせ直し中...");
  for (const table of SERIAL_TABLES) {
    await db.execute(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    );
    console.log(`  ${table}: OK`);
  }

  console.log("\n移行完了。");
}

main().catch((err) => {
  console.error("移行中にエラー:", err);
  process.exit(1);
});
