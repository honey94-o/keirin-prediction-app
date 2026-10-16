/**
 * 一回限りのマイグレーション（2026-10）：racesに中止フラグ列cancelledを追加する。
 * 中止レースは着順が永久に入らないため、記録しないと「未完了のレース」として
 * 通常同期・結果同期・補修が毎回取り直し続ける（静岡9/19 3Rを37回取り直していた）。
 * 立てるのはスクレイパー（出走表/結果ページの中止フラグを読んだ時）。
 * 使い方: npx tsx scripts/migrate-races-cancelled.ts
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../lib/db";

const envPath = path.join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  const db = getDb();
  await db.execute("ALTER TABLE races ADD COLUMN IF NOT EXISTS cancelled INTEGER NOT NULL DEFAULT 0");
  const { rows } = await db.execute("SELECT COUNT(*) AS c FROM races WHERE cancelled = 0");
  console.log(`races.cancelled 追加済み（cancelled=0: ${rows[0].c}件）`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
