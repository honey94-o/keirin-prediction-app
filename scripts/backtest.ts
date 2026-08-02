import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// next dev/buildは.env.localを自動で読むが、tsx単体では読まれないため手動でロードする。
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
import { savePrediction, getResultsForRace, getOddsForRace } from "../lib/repository";

interface ScenarioStat {
  races: number;
  hits: number;
  stake: number;
  payout: number;
}

async function main() {
  const jocdArg = process.argv[2]; // 例: "13,63" で開催場を絞り込み。省略時は結果があるレース全件
  const jocds = jocdArg ? jocdArg.split(",") : null;

  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ${jocds ? `AND ra.jocd IN (${jocds.map(() => "?").join(",")})` : ""}
     ORDER BY r.race_id`,
    jocds ?? []
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  console.log(`結果が確定しているレース: ${raceIds.length}件\n`);

  const scenarioStats = new Map<string, ScenarioStat>();
  const combined = { races: 0, hits: 0, stake: 0, payout: 0 };
  const box = { races: 0, hits: 0 };
  let honmeiWinHits = 0;
  let honmeiTop3Hits = 0;
  let honmeiTotal = 0;
  let skipped = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction) {
      skipped++;
      continue;
    }
    const { scored, scenarios, boxSuggestion } = prediction;
    if (scored.length === 0) {
      skipped++;
      continue;
    }

    await savePrediction(raceId, scored);

    const results = await getResultsForRace(raceId);
    const top3 = results
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
    if (top3.length < 3) {
      skipped++;
      continue;
    }
    const actualCombo = top3.map((r) => r.car_num).join("-");
    const actualTop3Set = new Set(top3.map((r) => r.car_num));

    const honmei = scored[0];
    honmeiTotal++;
    if (top3[0].car_num === honmei.entry.car_num) honmeiWinHits++;
    if (actualTop3Set.has(honmei.entry.car_num)) honmeiTop3Hits++;

    const odds = (await getOddsForRace(raceId)).filter((o) => o.bet_type === "3連単");
    const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

    for (const scenario of scenarios) {
      const stat = scenarioStats.get(scenario.label) ?? { races: 0, hits: 0, stake: 0, payout: 0 };
      stat.races++;
      const stake = 100 * scenario.formation.combinations.length;
      const hit = scenario.formation.combinations.includes(actualCombo);
      const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
      if (hit) stat.hits++;
      stat.stake += stake;
      stat.payout += payout;
      scenarioStats.set(scenario.label, stat);

      combined.stake += stake;
      combined.payout += payout;
    }
    if (scenarios.length > 0) {
      combined.races++;
      if (scenarios.some((s) => s.formation.combinations.includes(actualCombo))) combined.hits++;
    }

    if (boxSuggestion && boxSuggestion.combinations.length > 0) {
      box.races++;
      const sortedActual = [...actualTop3Set].sort((a, b) => a - b).join("-");
      if (boxSuggestion.combinations.includes(sortedActual)) box.hits++;
    }
  }

  console.log(`◎（本命軸）単勝的中率: ${honmeiTotal > 0 ? ((honmeiWinHits / honmeiTotal) * 100).toFixed(1) : "-"}% (${honmeiWinHits}/${honmeiTotal})`);
  console.log(`◎（本命軸）複勝的中率（3着以内）: ${honmeiTotal > 0 ? ((honmeiTop3Hits / honmeiTotal) * 100).toFixed(1) : "-"}% (${honmeiTop3Hits}/${honmeiTotal})`);
  console.log();

  console.log("シナリオ別 3連単フォーメーション的中率・回収率:");
  for (const [label, stat] of scenarioStats) {
    const hitRate = ((stat.hits / stat.races) * 100).toFixed(1);
    const roi = stat.stake > 0 ? ((stat.payout / stat.stake) * 100).toFixed(1) : "-";
    console.log(`  ${label}: 的中率${hitRate}% (${stat.hits}/${stat.races}) / 回収率${roi}% (賭け金${stat.stake}円 / 払戻${stat.payout.toFixed(0)}円)`);
  }
  console.log();

  const combinedHitRate = combined.races > 0 ? ((combined.hits / combined.races) * 100).toFixed(1) : "-";
  const combinedRoi = combined.stake > 0 ? ((combined.payout / combined.stake) * 100).toFixed(1) : "-";
  console.log(`全シナリオ合成（毎回全パターンに賭けた場合）: 的中率${combinedHitRate}% (${combined.hits}/${combined.races}) / 回収率${combinedRoi}% (賭け金${combined.stake}円 / 払戻${combined.payout.toFixed(0)}円)`);

  const boxHitRate = box.races > 0 ? ((box.hits / box.races) * 100).toFixed(1) : "-";
  console.log(`3連複ボックス的中率: ${boxHitRate}% (${box.hits}/${box.races}) ※払戻データ未取得のため回収率は算出せず`);

  if (skipped > 0) {
    console.log(`\n(出走数不足・結果不完全などでスキップ: ${skipped}件)`);
  }
}

main();
