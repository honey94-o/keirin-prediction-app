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
import { savePrediction, getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * 直近N日分（デフォルト30日）のレースについて、現在のスコアリングロジックで
 * 予想を再計算し、的中率・回収率（総払戻/総賭け金の加重平均、lib/accuracy.tsの
 * 修正と同じ方式）を集計する。backtest.tsの日付フィルタ版。
 * predictionsも保存するため、/history画面にもこの期間の結果が反映されるようになる。
 */
async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const daysBack = Number(process.argv[2] ?? 30);
  const today = todayJstStr();
  const sinceDate = addDaysToDateStr(today, -daysBack);

  const db = getDb();
  const raceIdsResult = await db.execute({
    sql: `SELECT DISTINCT r.race_id FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE r.finish_pos IS NOT NULL AND ra.kaisai_date >= ? AND ra.kaisai_date <= ?
          ORDER BY r.race_id`,
    args: [sinceDate, today],
  });
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  console.log(`対象期間: ${sinceDate} 〜 ${today}（直近${daysBack}日） / 結果確定レース: ${raceIds.length}件\n`);

  let honmeiWinHits = 0;
  let honmeiTop3Hits = 0;
  let honmeiTotal = 0;
  let formationHits = 0;
  let formationRaces = 0;
  let totalStake = 0;
  let totalPayout = 0;
  let skipped = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length === 0) {
      skipped++;
      continue;
    }
    const { scored, scenarios } = prediction;
    const honmeiFormationForSave = scenarios.find((s) => s.label === "本命")?.formation.combinations;
    await savePrediction(raceId, scored, honmeiFormationForSave);

    const results = await getResultsForRace(raceId);
    const top3 = results
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
    if (top3.length < 3) {
      skipped++;
      continue;
    }

    const honmei = scored[0];
    honmeiTotal++;
    if (top3[0].car_num === honmei.entry.car_num) honmeiWinHits++;
    if (top3.some((r) => r.car_num === honmei.entry.car_num)) honmeiTop3Hits++;

    const honmeiScenario = scenarios.find((s) => s.label === "本命");
    if (honmeiScenario) {
      const odds = (await getOddsForRace(raceId)).filter((o) => o.bet_type === "3連単");
      // 払戻オッズの組み合わせが1種類だけの時に限り正としての着順に使う
      // （同着対策・古い全オッズ盤保存レース対策。lib/accuracy.tsと同じロジック）。
      const distinctCombos = new Set(odds.map((o) => o.combination));
      const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
      const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");

      formationRaces++;
      const stake = 100 * honmeiScenario.formation.combinations.length;
      const hit = honmeiScenario.formation.combinations.includes(actualCombo);
      const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;
      const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
      if (hit) formationHits++;
      totalStake += stake;
      totalPayout += payout;
    }
  }

  console.log(`◎（本命軸）単勝的中率: ${honmeiTotal > 0 ? ((honmeiWinHits / honmeiTotal) * 100).toFixed(1) : "-"}% (${honmeiWinHits}/${honmeiTotal})`);
  console.log(`◎（本命軸）複勝的中率: ${honmeiTotal > 0 ? ((honmeiTop3Hits / honmeiTotal) * 100).toFixed(1) : "-"}% (${honmeiTop3Hits}/${honmeiTotal})`);
  console.log(`本命シナリオ 3連単的中率: ${formationRaces > 0 ? ((formationHits / formationRaces) * 100).toFixed(1) : "-"}% (${formationHits}/${formationRaces})`);
  console.log(`本命シナリオ 回収率（総払戻/総賭け金）: ${totalStake > 0 ? ((totalPayout / totalStake) * 100).toFixed(1) : "-"}% (賭け金${totalStake}円 / 払戻${totalPayout.toFixed(0)}円)`);
  if (skipped > 0) console.log(`(スキップ: ${skipped}件)`);
}

main();
