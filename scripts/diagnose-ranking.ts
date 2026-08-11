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

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r WHERE r.finish_pos IS NOT NULL ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  const winnerRankCounts = new Map<number, number>(); // 実際の1着が総合スコア順で何位だったか
  const winnerKyakushitsu = new Map<string, number>();
  const winnerLinePosition = new Map<string, number>();
  const winnerLineSize1 = { count: 0, total: 0 };
  const kimariteCounts = new Map<string, number>();
  let total = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length === 0) continue;
    const results = await getResultsForRace(raceId);
    const winnerResult = results.find((r) => r.finish_pos === 1);
    if (!winnerResult) continue;

    const ranked = [...prediction.scored].sort((a, b) => b.totalScore - a.totalScore);
    const rank = ranked.findIndex((s) => s.entry.car_num === winnerResult.car_num) + 1;
    if (rank <= 0) continue;

    total++;
    winnerRankCounts.set(rank, (winnerRankCounts.get(rank) ?? 0) + 1);

    const winnerEntry = ranked[rank - 1].entry;
    const kyak = winnerEntry.kyakushitsu ?? "不明";
    winnerKyakushitsu.set(kyak, (winnerKyakushitsu.get(kyak) ?? 0) + 1);
    const pos = winnerEntry.line_position ?? "不明";
    winnerLinePosition.set(pos, (winnerLinePosition.get(pos) ?? 0) + 1);

    if (winnerEntry.line_group != null) {
      const lineSize = prediction.scored.filter(
        (s) => s.entry.line_group === winnerEntry.line_group
      ).length;
      winnerLineSize1.total++;
      if (lineSize === 1) winnerLineSize1.count++;
    }

    if (winnerResult.kimarite) {
      kimariteCounts.set(winnerResult.kimarite, (kimariteCounts.get(winnerResult.kimarite) ?? 0) + 1);
    }
  }

  console.log(`集計対象: ${total}レース\n`);

  console.log("実際の1着が『総合スコア順』で何位だったか:");
  for (const [rank, count] of [...winnerRankCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${rank}位: ${count}件 (${((count / total) * 100).toFixed(1)}%)`);
  }

  console.log("\n実際の1着の脚質:");
  for (const [k, count] of winnerKyakushitsu) {
    console.log(`  ${k}: ${count}件 (${((count / total) * 100).toFixed(1)}%)`);
  }

  console.log("\n実際の1着の隊列内位置:");
  for (const [k, count] of winnerLinePosition) {
    console.log(`  ${k}: ${count}件 (${((count / total) * 100).toFixed(1)}%)`);
  }

  console.log(
    `\n実際の1着が単騎（ライン1人）だった割合: ${winnerLineSize1.count}/${winnerLineSize1.total} (${((winnerLineSize1.count / winnerLineSize1.total) * 100).toFixed(1)}%)`
  );

  console.log("\n決まり手（1着）:");
  for (const [k, count] of kimariteCounts) {
    console.log(`  ${k}: ${count}件`);
  }
}

main();
