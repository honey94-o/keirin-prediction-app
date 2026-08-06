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
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

// 仮説（ユーザー指摘）：直線の長いバンクでは、差し（kimarite_sashi_count）を
// 多く持つ選手の1着確率が上がるのではないか。
//
// 当初はbank_info.tyokusen（実測の直線距離）が5開催場分しかなく母数不足だったため
// 周長（333/400/500m）を代理指標にしていたが、scraper/backfill_bank_info.pyで
// 全開催場分のtyokusenを取得済み（31場）。実測値を使い、開催場を直線距離の
// 中央値で「長い/短い」の2群に分けてクロス集計する。
const SASHI_THRESHOLD = 6;

function parseTyokusenMeters(tyokusen: string | null): number | null {
  if (!tyokusen) return null;
  const m = /([\d.]+)/.exec(tyokusen);
  return m ? Number(m[1]) : null;
}

async function main() {
  const db = getDb();

  const bankRows = await db.execute("SELECT jocd, keirinjo_name, tyokusen FROM bank_info WHERE tyokusen IS NOT NULL");
  const banks = bankRows.rows as unknown as { jocd: string; keirinjo_name: string; tyokusen: string }[];
  const venueLength = new Map<string, number>();
  for (const b of banks) {
    const meters = parseTyokusenMeters(b.tyokusen);
    if (meters != null) venueLength.set(b.jocd, meters);
  }

  const lengths = [...venueLength.values()].sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  console.log(`直線距離データのある開催場: ${venueLength.size}場 / 中央値: ${median}m\n`);

  const raceRows = await db.execute("SELECT id, jocd FROM races");
  const races = raceRows.rows as unknown as { id: number; jocd: string }[];
  const raceIdToLength = new Map<number, number>();
  for (const r of races) {
    const len = venueLength.get(r.jocd);
    if (len != null) raceIdToLength.set(r.id, len);
  }

  const rows = await db.execute(`
    SELECT e.race_id, r.kimarite_sashi_count, res.finish_pos
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN results res ON res.race_id = e.race_id AND res.car_num = e.car_num
    WHERE res.finish_pos IS NOT NULL AND r.kimarite_sashi_count IS NOT NULL
  `);
  const data = rows.rows as unknown as { race_id: number; kimarite_sashi_count: number; finish_pos: number }[];

  type Agg = { total: number; wins: number };
  const table = new Map<string, Agg>(); // key: `${長い/短い}_${sashiBucket}`

  for (const row of data) {
    const length = raceIdToLength.get(row.race_id);
    if (length == null) continue;
    const lengthBucket = length >= median ? "直線長い" : "直線短い";
    const sashiBucket = row.kimarite_sashi_count >= SASHI_THRESHOLD ? `差し${SASHI_THRESHOLD}以上` : `差し${SASHI_THRESHOLD}未満`;
    const key = `${lengthBucket}_${sashiBucket}`;
    const agg = table.get(key) ?? { total: 0, wins: 0 };
    agg.total += 1;
    if (row.finish_pos === 1) agg.wins += 1;
    table.set(key, agg);
  }

  console.log(`=== 実測の直線距離(中央値${median}mで2分割)×選手の差し回数(${SASHI_THRESHOLD}以上/未満)別 勝率 ===`);
  for (const lengthBucket of ["直線短い", "直線長い"]) {
    for (const sashiBucket of [`差し${SASHI_THRESHOLD}以上`, `差し${SASHI_THRESHOLD}未満`]) {
      const key = `${lengthBucket}_${sashiBucket}`;
      const agg = table.get(key);
      if (!agg) continue;
      console.log(`  ${lengthBucket} × ${sashiBucket}: 母数${agg.total} 勝利${agg.wins} 勝率${((agg.wins / agg.total) * 100).toFixed(1)}%`);
    }
  }

  console.log(`\n=== 開催場別の直線距離（実測値） ===`);
  for (const [jocd, len] of [...venueLength.entries()].sort((a, b) => a[1] - b[1])) {
    const name = banks.find((b) => b.jocd === jocd)?.keirinjo_name ?? jocd;
    console.log(`  ${name}: ${len}m`);
  }
}

main();
