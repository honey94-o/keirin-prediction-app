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
import { predictRace } from "../lib/predict";
import { getResultsForRace } from "../lib/repository";

const BUCKETS: [number, number, string][] = [
  [0, 2, "0-2日(連闘)"],
  [3, 6, "3-6日"],
  [7, 21, "7-21日"],
  [22, 40, "22-40日"],
  [41, 60, "41-60日"],
  [61, Infinity, "61日+"],
];

function bucketLabel(days: number): string {
  for (const [lo, hi, label] of BUCKETS) {
    if (days >= lo && days <= hi) return label;
  }
  return "不明";
}

async function main() {
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r WHERE r.finish_pos IS NOT NULL ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  const byBucket = new Map<string, { entries: number; wins: number }>();

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length === 0) continue;
    const results = await getResultsForRace(raceId);
    const finishByCarNum = new Map(results.map((r) => [r.car_num, r.finish_pos]));

    for (const s of prediction.scored) {
      const daysText = s.statsScore.factors["出走間隔"];
      if (typeof daysText !== "string" || !daysText.endsWith("日")) continue;
      const days = Number(daysText.slice(0, -1));
      if (!Number.isFinite(days)) continue;
      const label = bucketLabel(days);
      const bucket = byBucket.get(label) ?? { entries: 0, wins: 0 };
      bucket.entries++;
      if (finishByCarNum.get(s.entry.car_num) === 1) bucket.wins++;
      byBucket.set(label, bucket);
    }
  }

  console.log("出走間隔バケット別の母数・勝率:");
  for (const [, , label] of BUCKETS) {
    const b = byBucket.get(label);
    if (!b) continue;
    console.log(`  ${label}: 出走${b.entries} 勝率${((b.wins / b.entries) * 100).toFixed(1)}%`);
  }
}

main();
