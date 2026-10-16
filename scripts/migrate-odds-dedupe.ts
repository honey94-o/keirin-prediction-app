/**
 * 一回限りのマイグレーション（2026-10）：oddsの重複行を削除し、(race_id, bet_type, combination)
 * の一意インデックスを張る。スクレイパーの払戻保存が素のINSERTで、確定済みレースを
 * 再取得するたびに同じ行が溜まっていた（最大38重複）。保存側はON CONFLICT DO NOTHINGに
 * 修正済みで、このインデックスで以後の重複を構造的に防ぐ。残すのは各組の最新行（id最大）。
 * 使い方: npx tsx scripts/migrate-odds-dedupe.ts
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
  const before = await db.execute("SELECT COUNT(*) AS c FROM odds");
  await db.execute(`
    DELETE FROM odds o
    USING odds newer
    WHERE o.race_id = newer.race_id AND o.bet_type = newer.bet_type
      AND o.combination = newer.combination AND o.id < newer.id`);
  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_unique ON odds(race_id, bet_type, combination)"
  );
  const after = await db.execute("SELECT COUNT(*) AS c FROM odds");
  console.log(`odds: ${before.rows[0].c}行 → ${after.rows[0].c}行（一意インデックス作成済み）`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
