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
import { getResultsForRace, getOddsForRace } from "../lib/repository";
import { HIGH_CONFIDENCE_MARGIN } from "../lib/scoring";

// ユーザー質問への回答用スクリプト：
// ①高信頼度レース（本命が抜けている＝margin>=HIGH_CONFIDENCE_MARGIN）で、
//   単勝（軸が実際に1着）と、本命3連単フォーメーション（2点）の的中率・回収率を比較。
//   「1着固定の買い目だけでいいのでは」を検証する材料にする。
// ②本命が外れたレース（honmeiHit=false）に絞って、まくり/差し一撃・逃げ粘り込み・
//   単騎一撃の各シナリオが実際にどれだけ拾えているかを見る。

type Agg = { races: number; hits: number; stake: number; payout: number };
function newAgg(): Agg {
  return { races: 0, hits: 0, stake: 0, payout: 0 };
}

async function main() {
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  console.log(`結果確定レース: ${raceIds.length}件\n`);

  // ①高信頼度レース集計
  let hcTotal = 0;
  let hcAxisWin = 0;
  const hcFormation = newAgg();

  // ②本命失敗レースでの各シナリオ集計
  let honmeiFailTotal = 0;
  const altScenarioStats = new Map<string, Agg>();
  let anyAltHit = 0; // 本命失敗レースのうち、逃げ粘り込み/まくり差し一撃/単騎一撃のどれかが当たった数

  let skipped = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length < 2) {
      skipped++;
      continue;
    }
    const { scored, scenarios } = prediction;

    const results = await getResultsForRace(raceId);
    const top3 = results
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
    if (top3.length < 3) {
      skipped++;
      continue;
    }

    const odds = (await getOddsForRace(raceId)).filter((o) => o.bet_type === "3連単");
    const distinctCombos = new Set(odds.map((o) => o.combination));
    const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
    const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");
    const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

    const honmei = scored[0];
    const taikou = scored[1];
    const margin = honmei.totalScore - taikou.totalScore;
    const axisWin = top3[0].car_num === honmei.entry.car_num;

    const honmeiScenario = scenarios.find((s) => s.label === "本命");

    if (margin >= HIGH_CONFIDENCE_MARGIN) {
      hcTotal++;
      if (axisWin) hcAxisWin++;
      if (honmeiScenario) {
        hcFormation.races++;
        const stake = 100 * honmeiScenario.formation.combinations.length;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
        if (hit) hcFormation.hits++;
        hcFormation.stake += stake;
        hcFormation.payout += payout;
      }
    }

    if (!axisWin) {
      honmeiFailTotal++;
      let anyHitThisRace = false;
      for (const scenario of scenarios) {
        if (scenario.label === "本命") continue;
        const agg = altScenarioStats.get(scenario.label) ?? newAgg();
        agg.races++;
        const stake = 100 * scenario.formation.combinations.length;
        const hit = scenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
        if (hit) {
          agg.hits++;
          anyHitThisRace = true;
        }
        agg.stake += stake;
        agg.payout += payout;
        altScenarioStats.set(scenario.label, agg);
      }
      if (anyHitThisRace) anyAltHit++;
    }
  }

  console.log("=== ① 高信頼度レース（本命margin>=" + HIGH_CONFIDENCE_MARGIN + "）===");
  console.log(`母数: ${hcTotal}件`);
  console.log(`軸（◎）が実際に1着だった率: ${((hcAxisWin / hcTotal) * 100).toFixed(1)}% (${hcAxisWin}/${hcTotal})`);
  console.log(
    `本命3連単フォーメーション（${hcFormation.races > 0 ? "2点前後" : "-"}）: ` +
      `的中率${((hcFormation.hits / hcFormation.races) * 100).toFixed(1)}% (${hcFormation.hits}/${hcFormation.races}) ` +
      `回収率${((hcFormation.payout / hcFormation.stake) * 100).toFixed(1)}% ` +
      `(賭け金${hcFormation.stake}円 / 払戻${hcFormation.payout.toFixed(0)}円)`
  );
  console.log(
    `※単勝オッズは未取得のため単勝の回収率は算出不可。軸の勝率(的中率)のみ参考値として算出。`
  );

  console.log("\n=== ② 本命（◎）が外れたレースで、他シナリオがどれだけ拾えているか ===");
  console.log(`本命が外れたレース: ${honmeiFailTotal}件`);
  for (const [label, agg] of altScenarioStats) {
    const hitRate = ((agg.hits / agg.races) * 100).toFixed(1);
    const roi = agg.stake > 0 ? ((agg.payout / agg.stake) * 100).toFixed(1) : "-";
    console.log(
      `  ${label}: 的中率${hitRate}% (${agg.hits}/${agg.races}) 回収率${roi}% ` +
        `(賭け金${agg.stake}円 / 払戻${agg.payout.toFixed(0)}円)`
    );
  }
  console.log(
    `\n本命が外れたレースのうち、逃げ粘り込み/まくり差し一撃/単騎一撃のいずれかで拾えた率: ` +
      `${((anyAltHit / honmeiFailTotal) * 100).toFixed(1)}% (${anyAltHit}/${honmeiFailTotal})`
  );

  if (skipped > 0) console.log(`\n(スキップ: ${skipped}件)`);
}

main();
