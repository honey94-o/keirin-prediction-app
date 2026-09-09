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
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, resolveActualCombo, enableReadCache } from "../lib/repository";
import { buildLineAwarePool } from "../lib/scoring";

/**
 * 傾斜配点（買い目研究で見つかった「同じフォーメーション内でも並びごとに
 * 金額を傾斜配分する」手法）を実装する前に、実際のオッズを使って
 * 「均等配点 vs 傾斜配点」で回収率がどう変わるかを検証する。
 * scripts/diagnose-formation-stake-weighting.tsで検証済みの、プール内順位
 * （buildLineAwarePool）別の実際の2着・3着頻度をそのまま重みとして使う。
 *
 * 前回の展開予想の反省（検証せずに実装してユーザーに指摘された）を踏まえ、
 * 実際に金額を動かす前に、過去データで本当に回収率が上がるかを確認する。
 * 総投資額は変えず（均等配点と同じ合計）、配分だけを変える前提で計算する。
 */

// scripts/diagnose-formation-stake-weighting.tsで実測した値（5000件、本命が1着の
// レースに限定）。プール6番手以降はまとめて1つの代表値として扱う。
const P2ND_BY_RANK = [48.9, 16.1, 13.3, 9.6, 7.3, 4.9];
const P3RD_BY_RANK = [18.2, 29.3, 17.4, 14.5, 10.7, 10.0];

function rankIndex(poolIndex: number): number {
  return Math.min(poolIndex, P2ND_BY_RANK.length - 1);
}

type ComboWeight = { combo: string; weight: number };

function weightedCombos(axis: number, pool: number[], poolSize: number): ComboWeight[] {
  const candidates = pool.slice(0, poolSize);
  const out: ComboWeight[] = [];
  for (let si = 0; si < candidates.length; si++) {
    for (let ti = 0; ti < candidates.length; ti++) {
      if (si === ti) continue;
      const second = candidates[si];
      const third = candidates[ti];
      const weight = P2ND_BY_RANK[rankIndex(si)] * P3RD_BY_RANK[rankIndex(ti)];
      out.push({ combo: `${axis}-${second}-${third}`, weight });
    }
  }
  return out;
}

async function main() {
  enableReadCache();
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  let raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit) raceIds = raceIds.slice(-limit);
  console.log(`対象レース: ${raceIds.length}件${limit ? `（直近${limit}件に絞り込み）` : ""}`);

  let flatStake = 0;
  let flatPayout = 0;
  let weightedStake = 0;
  let weightedPayout = 0;
  let races = 0;
  let hits = 0;
  const dailyFlat = new Map<string, { stake: number; payout: number }>();
  const dailyWeighted = new Map<string, { stake: number; payout: number }>();

  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction) return;
        const { scored, race } = prediction;
        const honmeiScenario = prediction.scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario || honmeiScenario.formation.betType !== "3連単フォーメーション") return;
        const combos = honmeiScenario.formation.combinations;
        if (combos.length === 0) return;

        const honmei = scored[0];
        const pool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored);
        // poolSizeは実際に使われた点数から逆算する（同じロジックをformationFromPoolと合わせる）
        let poolSize = 2;
        for (let m = 2; m <= pool.length; m++) {
          if (m * (m - 1) > combos.length) break;
          poolSize = m;
        }
        const weighted = weightedCombos(honmei.entry.car_num, pool, poolSize);
        // 組み合わせの集合が完全一致する時だけ対象にする（拮抗レースはformationBoxTop2
        // という別ロジック「1=2-3」のswap買いになり、ここでの再現とかみ合わないため
        // 自然に除外される。件数が偶然一致するだけの誤マッチを避けるため文字列集合で厳密に比較）。
        const weightedSet = new Set(weighted.map((w) => w.combo));
        const combosSet = new Set(combos);
        if (weightedSet.size !== combosSet.size || ![...combosSet].every((c) => weightedSet.has(c))) return;

        const raceResults = await getResultsForRace(raceId);
        const odds = await getOddsForRace(raceId);
        const actualCombo = resolveActualCombo(raceResults, odds);
        if (actualCombo == null) return;

        const hitOdds =
          odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
        const hit = combos.includes(actualCombo);
        if (hit && !weightedSet.has(actualCombo)) return; // 念のための二重防御

        const totalStakeFlat = 100 * combos.length;
        const totalWeight = weighted.reduce((a, b) => a + b.weight, 0);

        races++;
        if (hit) hits++;
        flatStake += totalStakeFlat;
        weightedStake += totalStakeFlat; // 総投資額は変えない前提

        const fDay = dailyFlat.get(race.kaisai_date) ?? { stake: 0, payout: 0 };
        const wDay = dailyWeighted.get(race.kaisai_date) ?? { stake: 0, payout: 0 };
        fDay.stake += totalStakeFlat;
        wDay.stake += totalStakeFlat;

        if (hit && hitOdds != null) {
          flatPayout += 100 * hitOdds;
          fDay.payout += 100 * hitOdds;

          const hitWeight = weighted.find((w) => w.combo === actualCombo)!.weight;
          const hitStakeWeighted = totalStakeFlat * (hitWeight / totalWeight);
          weightedPayout += hitStakeWeighted * hitOdds;
          wDay.payout += hitStakeWeighted * hitOdds;
        }
        dailyFlat.set(race.kaisai_date, fDay);
        dailyWeighted.set(race.kaisai_date, wDay);
      })
    );
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n対象（本命が3連単フォーメーション）: ${races}件 的中${hits}件\n`);
  console.log(`■ 均等配点: 回収率${((flatPayout / flatStake) * 100).toFixed(1)}% (賭け金${flatStake}円 / 払戻${flatPayout.toFixed(0)}円)`);
  console.log(`■ 傾斜配点: 回収率${((weightedPayout / weightedStake) * 100).toFixed(1)}% (賭け金${weightedStake}円 / 払戻${weightedPayout.toFixed(0)}円)`);

  const dates = [...dailyFlat.keys()].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  function sumPeriod(map: Map<string, { stake: number; payout: number }>, from: (d: string) => boolean) {
    let s = 0, p = 0;
    for (const [d, v] of map) if (from(d)) { s += v.stake; p += v.payout; }
    return { s, p };
  }
  const flatTrain = sumPeriod(dailyFlat, (d) => d < splitDate);
  const flatTest = sumPeriod(dailyFlat, (d) => d >= splitDate);
  const wTrain = sumPeriod(dailyWeighted, (d) => d < splitDate);
  const wTest = sumPeriod(dailyWeighted, (d) => d >= splitDate);
  console.log(`\ntrain=${dates[0]}〜${splitDate}、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log(`  [train] 均等${((flatTrain.p / flatTrain.s) * 100).toFixed(1)}% / 傾斜${((wTrain.p / wTrain.s) * 100).toFixed(1)}%`);
  console.log(`  [test]  均等${((flatTest.p / flatTest.s) * 100).toFixed(1)}% / 傾斜${((wTest.p / wTest.s) * 100).toFixed(1)}%`);
}

main();
