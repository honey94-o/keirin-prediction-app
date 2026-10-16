/**
 * 一回限りのマイグレーション（2026-10）：全レースの予想スナップショット race_snapshots を作る
 * （db/schema.sql・lib/race-snapshot.ts参照）。scripts/compute-picks.tsが保存し、
 * ホーム・/picks・開催場ページが表示のたびにpredictRaceを実行しないで済むようにする。
 * 作成後、次のdaily-sync（または npx tsx scripts/compute-picks.ts）から行が入る。
 * それまで・発走済みで計算し直されないレースは、画面側が従来どおりpredictRaceで表示する。
 * 使い方: npx tsx scripts/migrate-race-snapshots.ts
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
  // marginは「高信頼度」（>=10）の判定に使うため、REAL（Postgresでは単精度）で丸めて
  // 境界の判定がpredictRaceの値とずれないよう倍精度にする。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS race_snapshots (
      race_id        INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
      kaisai_date    TEXT NOT NULL,
      margin         DOUBLE PRECISION,
      top_entries    TEXT NOT NULL,
      scenarios      TEXT NOT NULL,
      honmei_reason  TEXT,
      weights        TEXT NOT NULL,
      updated_at     TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  const { rows } = await db.execute("SELECT COUNT(*) AS c FROM race_snapshots");
  console.log(`race_snapshots 作成済み（現在${rows[0].c}件）`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
