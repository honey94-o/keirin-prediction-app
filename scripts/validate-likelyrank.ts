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

interface Bucket {
  races: number;
  hits: number;
}

async function main() {
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r WHERE r.finish_pos IS NOT NULL ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  // label -> rank -> {races, hits}
  const byLabelRank = new Map<string, Map<number, Bucket>>();
  let skipped = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length === 0) {
      skipped++;
      continue;
    }
    const { scenarios } = prediction;

    const results = await getResultsForRace(raceId);
    const top3 = results
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
    if (top3.length < 3) {
      skipped++;
      continue;
    }
    const actualCombo = top3.map((r) => r.car_num).join("-");

    for (const scenario of scenarios) {
      const rankMap = byLabelRank.get(scenario.label) ?? new Map<number, Bucket>();
      const bucket = rankMap.get(scenario.likelyRank) ?? { races: 0, hits: 0 };
      bucket.races++;
      if (scenario.formation.combinations.includes(actualCombo)) bucket.hits++;
      rankMap.set(scenario.likelyRank, bucket);
      byLabelRank.set(scenario.label, rankMap);
    }
  }

  console.log(`集計対象: ${raceIds.length - skipped}レース\n`);
  console.log("シナリオラベル別・有力度順位（likelyRank）別の的中率:");
  console.log("（rankが小さいほど『そのレースで軸の総合スコアが高かった』ことを意味する）\n");

  for (const [label, rankMap] of byLabelRank) {
    console.log(`[${label}]`);
    const sorted = [...rankMap.entries()].sort((a, b) => a[0] - b[0]);
    for (const [rank, bucket] of sorted) {
      const hitRate = ((bucket.hits / bucket.races) * 100).toFixed(1);
      console.log(`  rank${rank}: 的中率${hitRate}% (${bucket.hits}/${bucket.races})`);
    }
    console.log();
  }
}

main();
