/**
 * 一回限りのマイグレーション（2026-10）：barikata_picksに confidence（この1点が当たる確率の
 * 見積もり＝◎の1着確率×2・3着ペアの確率）を追加する。compute-picksが保存し、画面は
 * BARIKATA_HIGH_CONFIDENCE以上に「確度高」の印を付ける（lib/second-third-model.ts）。
 * 使い方: npx tsx scripts/migrate-barikata-confidence.ts
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
  await db.execute("ALTER TABLE barikata_picks ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION");
  console.log("barikata_picks.confidence 追加済み");
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
