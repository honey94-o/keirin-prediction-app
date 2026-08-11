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
import { getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";
import { HIGH_CONFIDENCE_MARGIN } from "../lib/scoring";

// 高信頼度レース（本命margin>=HIGH_CONFIDENCE_MARGIN）専用に、本命フォーメーションの
// 点数（2着・3着候補プールのサイズ）を変えた時の的中率・回収率を比較する。
// 現状は2点固定。軸の勝率82.7%に対し3連単的中率34.9%・回収率78.1%と大きく
// 見劣りしていたため、プールを広げた方が得か検証する。

// axis-2着-3着のフォーメーション（formationFromPoolと同じロジックをここで再現）
function formationFromPool(axis: number, orderedPool: number[], maxPoints: number): string[] {
  if (orderedPool.length < 2) return [];
  let poolSize = 2;
  for (let m = 2; m <= orderedPool.length; m++) {
    if (m * (m - 1) > maxPoints) break;
    poolSize = m;
  }
  const candidates = orderedPool.slice(0, poolSize);
  const combos: string[] = [];
  for (const second of candidates) {
    for (const third of candidates) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

const CANDIDATE_BUDGETS = [2, 4, 6, 12, 20];

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  const statsByBudget = new Map<number, { races: number; hits: number; stake: number; payout: number }>();
  for (const b of CANDIDATE_BUDGETS) statsByBudget.set(b, { races: 0, hits: 0, stake: 0, payout: 0 });

  let hcTotal = 0;
  let skipped = 0;

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length < 2) {
      skipped++;
      continue;
    }
    const { scored } = prediction;
    const honmei = scored[0];
    const taikou = scored[1];
    const margin = honmei.totalScore - taikou.totalScore;
    if (margin < HIGH_CONFIDENCE_MARGIN) continue;

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

    hcTotal++;

    // buildLineAwarePoolと同じ考え方だが、ここでは簡略化して総合スコア順の
    // 車番リスト（軸除く）をプールとして使う（ライン優先の細かい並び替えは
    // 本質的な論点ではないため、まずは点数そのものの効果を見る）。
    const pool = scored
      .filter((s) => s.entry.car_num !== honmei.entry.car_num)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((s) => s.entry.car_num);

    for (const budget of CANDIDATE_BUDGETS) {
      const combos = formationFromPool(honmei.entry.car_num, pool, budget);
      const stat = statsByBudget.get(budget)!;
      stat.races++;
      const stake = 100 * combos.length;
      const hit = combos.includes(actualCombo);
      const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
      if (hit) stat.hits++;
      stat.stake += stake;
      stat.payout += payout;
    }
  }

  console.log(`高信頼度レース（margin>=${HIGH_CONFIDENCE_MARGIN}）母数: ${hcTotal}件（スキップ${skipped}件）\n`);
  console.log("点数(概算予算) | 実際の点数目安 | 的中率 | 回収率 | 賭け金 | 払戻");
  for (const budget of CANDIDATE_BUDGETS) {
    const s = statsByBudget.get(budget)!;
    const hitRate = ((s.hits / s.races) * 100).toFixed(1);
    const roi = s.stake > 0 ? ((s.payout / s.stake) * 100).toFixed(1) : "-";
    const avgPoints = (s.stake / s.races / 100).toFixed(1);
    console.log(
      `budget=${budget}: 平均${avgPoints}点/レース 的中率${hitRate}% (${s.hits}/${s.races}) ` +
        `回収率${roi}% (賭け金${s.stake}円 / 払戻${s.payout.toFixed(0)}円)`
    );
  }
}

main();
