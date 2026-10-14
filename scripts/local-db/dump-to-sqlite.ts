/**
 * 本番Neonの予想・検証に必要なテーブルを、ローカルSQLite（scripts/data/local.sqlite、
 * gitignore済み）に一括コピーする。1テーブル1クエリの一括取得だけで、
 * レース単位のクエリは一切発行しない（Neon無料枠の転送量対策）。
 * 使い方: npx tsx scripts/local-db/dump-to-sqlite.ts
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { openLocalDb, LOCAL_DB_PATH } from "../lib/local-db";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
}

const TABLES = ["races", "racers", "entries", "results", "odds", "racer_race_history", "bank_info", "settings"];

async function main() {
  loadDotEnvLocal();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  if (existsSync(LOCAL_DB_PATH)) rmSync(LOCAL_DB_PATH);
  const db = openLocalDb();
  db.exec(readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf-8"));
  db.exec("DELETE FROM settings");

  let totalRows = 0;
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    if (rows.length === 0) continue;
    const localCols = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    );
    const cols = Object.keys(rows[0]).filter((c) => localCols.has(c));
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    );
    db.exec("BEGIN");
    for (const row of rows) {
      insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
    }
    db.exec("COMMIT");
    totalRows += rows.length;
    console.log(`${table}: ${rows.length}行`);
  }

  // repositoryの集計クエリ（位置別勝率・決まり手率・個人履歴）をローカルで速く回すための索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_results_snum ON results(snum);
    CREATE INDEX IF NOT EXISTS idx_results_race_pos ON results(race_id, finish_pos);
    CREATE INDEX IF NOT EXISTS idx_entries_snum_race ON entries(snum, race_id);
    CREATE INDEX IF NOT EXISTS idx_history_snum ON racer_race_history(snum);
    CREATE INDEX IF NOT EXISTS idx_races_date ON races(kaisai_date);
    ANALYZE;
  `);
  console.log(`合計 ${totalRows}行 → ${LOCAL_DB_PATH}`);
  db.close();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
