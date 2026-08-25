import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

/**
 * Turso（現行DB）の支払い問題で読めなくなる前に、全テーブルを丸ごとローカルへ
 * バックアップする。新しいDB（新規Turso等）へ移し替えるscripts/restore-db.tsの
 * 入力としても使う。db/schema.sqlに定義された全テーブルをJSONで1テーブル1
 * ファイルに書き出す（.gitignore対象、機密性の高い実データのためコミットしない）。
 */

const TABLES = [
  "racers",
  "races",
  "bank_info",
  "racer_race_history",
  "settings",
  "entries",
  "results",
  "odds",
  "predictions",
  "scenario_stats",
  "daily_picks",
];

async function main() {
  const db = getDb();
  const outDir = path.join(process.cwd(), "db", "backup");
  mkdirSync(outDir, { recursive: true });

  for (const table of TABLES) {
    const result = await db.execute(`SELECT * FROM ${table}`);
    const rows = result.rows as unknown[];
    const outPath = path.join(outDir, `${table}.json`);
    writeFileSync(outPath, JSON.stringify(rows), "utf-8");
    console.log(`${table}: ${rows.length}行 -> ${outPath}`);
  }
  console.log("\nバックアップ完了。");
}

main().catch((err) => {
  console.error("バックアップ中にエラー:", err);
  process.exit(1);
});
