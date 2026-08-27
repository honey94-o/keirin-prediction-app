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
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * diagnose-hc-formation-size.tsと同じ手法だが、日付で絞り込んで
 * 「直近だけ本当に悪化しているのか」を time-segmented に検証する版。
 * daily_picksベースの直近60日集計（20点回収率33.9%）と、全履歴backtest
 * （20点回収率126.7%）の食い違いを切り分けるのが目的。
 */

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

const CANDIDATE_BUDGETS = [2, 6, 12, 20];
const DAYS_BACK = Number(process.argv[2] ?? 60);

async function main() {
  enableReadCache();

  const today = todayJstStr();
  const sinceDate = addDaysToDateStr(today, -DAYS_BACK);

  const db = getDb();
  const raceIdsResult = await db.execute({
    sql: `SELECT DISTINCT r.race_id FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE r.finish_pos IS NOT NULL AND ra.kaisai_date >= ?
          ORDER BY r.race_id`,
    args: [sinceDate],
  });
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  console.log(`対象期間: ${sinceDate} 〜 ${today} (直近${DAYS_BACK}日) / 結果確定レース: ${raceIds.length}件`);

  const statsByBudget = new Map<number, { races: number; hits: number; stake: number; payout: number }>();
  for (const b of CANDIDATE_BUDGETS) statsByBudget.set(b, { races: 0, hits: 0, stake: 0, payout: 0 });

  let hcTotal = 0;
  const perRaceLog: { date: string; margin: number; hit20: boolean; payout20: number }[] = [];

  for (const raceId of raceIds) {
    const prediction = await predictRace(raceId);
    if (!prediction || prediction.scored.length < 2) continue;
    const { scored, race } = prediction;
    const honmei = scored[0];
    const taikou = scored[1];
    const margin = honmei.totalScore - taikou.totalScore;
    if (margin < HIGH_CONFIDENCE_MARGIN) continue;

    const results = await getResultsForRace(raceId);
    const top3 = results
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
    if (top3.length < 3) continue;
    const odds = (await getOddsForRace(raceId)).filter((o) => o.bet_type === "3連単");
    const distinctCombos = new Set(odds.map((o) => o.combination));
    const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
    const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");
    const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

    hcTotal++;
    const pool = scored
      .filter((s) => s.entry.car_num !== honmei.entry.car_num)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((s) => s.entry.car_num);

    let hit20 = false;
    let payout20 = 0;
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
      if (budget === 20) {
        hit20 = hit;
        payout20 = payout;
      }
    }
    perRaceLog.push({ date: race.kaisai_date, margin, hit20, payout20 });
  }

  console.log(`高信頼度レース（margin>=${HIGH_CONFIDENCE_MARGIN}）母数: ${hcTotal}件\n`);
  console.log("点数 | 的中率 | 回収率 | 賭け金 | 払戻");
  for (const budget of CANDIDATE_BUDGETS) {
    const s = statsByBudget.get(budget)!;
    const hitRate = ((s.hits / s.races) * 100).toFixed(1);
    const roi = s.stake > 0 ? ((s.payout / s.stake) * 100).toFixed(1) : "-";
    console.log(`  ${budget}点: 的中率${hitRate}% (${s.hits}/${s.races}) 回収率${roi}% (賭け金${s.stake}円 / 払戻${s.payout.toFixed(0)}円)`);
  }

  // 週単位で20点のROI推移を見る
  console.log("\n■ 週単位の20点ROI推移:");
  const byWeek = new Map<string, { stake: number; payout: number; races: number; hits: number }>();
  for (const r of perRaceLog) {
    const weekKey = r.date.slice(0, 6) + "-W" + Math.ceil(Number(r.date.slice(6, 8)) / 7);
    const s = byWeek.get(weekKey) ?? { stake: 0, payout: 0, races: 0, hits: 0 };
    s.races++;
    if (r.hit20) s.hits++;
    s.stake += 2000; // 20点固定
    s.payout += r.payout20;
    byWeek.set(weekKey, s);
  }
  for (const [week, s] of [...byWeek.entries()].sort()) {
    const roi = ((s.payout / s.stake) * 100).toFixed(1);
    console.log(`  ${week}: ${s.races}件 的中${s.hits}件 回収率${roi}%`);
  }
}

main();
