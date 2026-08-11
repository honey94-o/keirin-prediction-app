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
import { getResultsForRace, enableReadCache } from "../lib/repository";

const MARGIN_BUCKETS: [number, number, string][] = [
  [0, 3, "0-3点差"],
  [3, 6, "3-6点差"],
  [6, 10, "6-10点差"],
  [10, 20, "10-20点差"],
  [20, Infinity, "20点差+"],
];

function bucketLabel(margin: number): string {
  for (const [lo, hi, label] of MARGIN_BUCKETS) {
    if (margin >= lo && margin < hi) return label;
  }
  return "不明";
}

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r WHERE r.finish_pos IS NOT NULL ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  const byBucket = new Map<string, { races: number; wins: number; top3: number }>();
  let total = 0;

  // ◎軸の選手ごとの通算「◎に選ばれた回数・的中回数」も同時に集計する
  const byRacer = new Map<string, { times: number; wins: number; name: string }>();

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length < 2) continue;
    const results = await getResultsForRace(raceId);
    const finishByCarNum = new Map(results.map((r) => [r.car_num, r.finish_pos]));

    const [first, second] = prediction.scored;
    const margin = first.totalScore - second.totalScore;
    const label = bucketLabel(margin);
    const finishPos = finishByCarNum.get(first.entry.car_num);
    if (finishPos == null) continue;

    total++;
    const bucket = byBucket.get(label) ?? { races: 0, wins: 0, top3: 0 };
    bucket.races++;
    if (finishPos === 1) bucket.wins++;
    if (finishPos <= 3) bucket.top3++;
    byBucket.set(label, bucket);

    const racerStat = byRacer.get(first.entry.snum) ?? { times: 0, wins: 0, name: first.entry.name };
    racerStat.times++;
    if (finishPos === 1) racerStat.wins++;
    byRacer.set(first.entry.snum, racerStat);
  }

  console.log(`集計対象: ${total}レース\n`);
  console.log("本命(1位)と2位の総合スコア差 別の◎的中率:");
  for (const [, , label] of MARGIN_BUCKETS) {
    const b = byBucket.get(label);
    if (!b) continue;
    console.log(
      `  ${label}: ${b.races}レース 単勝的中率${((b.wins / b.races) * 100).toFixed(1)}% 複勝的中率${((b.top3 / b.races) * 100).toFixed(1)}%`
    );
  }

  console.log("\n◎に選ばれた回数の分布（選手ごと）:");
  const counts = [...byRacer.values()].map((r) => r.times);
  const distribution = new Map<number, number>();
  for (const c of counts) distribution.set(c, (distribution.get(c) ?? 0) + 1);
  for (const [times, numRacers] of [...distribution.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ◎${times}回: ${numRacers}選手`);
  }

  for (const threshold of [3, 5, 8, 10]) {
    const qualifying = [...byRacer.values()].filter((r) => r.times >= threshold);
    console.log(`\n◎${threshold}回以上の選手: ${qualifying.length}名`);
  }
}

main();
