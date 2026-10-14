/**
 * 一回限りのマイグレーション（2026-10）：entriesにレース時点の選手成績スナップショット
 * 列(at_*)を追加する。racersは選手1行を上書きし続けるため、過去レースをracersで
 * 再予想するとレース後に判明した成績（競走得点など）を使ってしまい、バックテストが
 * 本番より良く見えていた。以後はスクレイパー（keirin_scraper.save_to_db）が初回取得時の
 * 値をat_*に残す。まだ結果の出ていないレースは現在のracersがレース前の値なので初期値に使う。
 * 使い方: npx tsx scripts/migrate-entries-at-snapshot.ts
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

const COLS: [string, string, string][] = [
  ["at_heikin_tokuten", "REAL", "heikin_tokuten"],
  ["at_class_rank", "TEXT", "class_rank"],
  ["at_kyakushitsu", "TEXT", "kyakushitsu"],
  ["at_syouritu", "REAL", "syouritu"],
  ["at_rentairitu2", "REAL", "rentairitu2"],
  ["at_rentairitu3", "REAL", "rentairitu3"],
  ["at_kimarite_nige_count", "INTEGER", "kimarite_nige_count"],
  ["at_kimarite_makuri_count", "INTEGER", "kimarite_makuri_count"],
  ["at_kimarite_sashi_count", "INTEGER", "kimarite_sashi_count"],
  ["at_kimarite_mark_count", "INTEGER", "kimarite_mark_count"],
  ["at_standing_count", "INTEGER", "standing_count"],
  ["at_home_lead_count", "INTEGER", "home_lead_count"],
  ["at_back_lead_count", "INTEGER", "back_lead_count"],
];

async function main() {
  const db = getDb();
  for (const [col, type] of COLS) {
    await db.execute(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }
  const set = COLS.map(([col, , src]) => `${col} = r.${src}`).join(", ");
  await db.execute(`
    UPDATE entries e SET ${set}
    FROM racers r
    WHERE e.snum = r.snum AND e.at_heikin_tokuten IS NULL
      AND NOT EXISTS (SELECT 1 FROM results x WHERE x.race_id = e.race_id)`);
  const { rows } = await db.execute("SELECT COUNT(*) AS c FROM entries WHERE at_heikin_tokuten IS NOT NULL");
  console.log(`at_*付きentries: ${rows[0].c}件`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
