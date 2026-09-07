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

/**
 * ユーザー指摘：「おすすめの組み合わせ」機能はscenario_statsの全レース累計を見て
 * いるだけで、本命が母数的に一番強いのは当然。レースごとの状況（バンクの決まり手
 * 傾向・本命との僅差度合い）で本命以外が有利になるタイミングを見極めて初めて
 * 「おすすめ」の意味があるはず、という指摘を受けて検証する。
 *
 * 検証対象：
 * 1. margin（本命-対抗のスコア差）が小さいほど、本命以外のシナリオが当たる
 *    相対頻度が上がるか。
 * 2. 既存のlikelyRank（軸のスコアが本命にどれだけ肉薄しているか）が、
 *    実際にそのシナリオの的中率と相関しているか（今は理由文の説明にしか
 *    使っていない、検証されていない指標）。
 * 3. バンクの決まり手傾向（venueKimarite/bankInfoのnige_pct・makuri_pct+sashi_pct）が、
 *    対応するシナリオ（逃げ粘り込み↔nige_pct、まくり/差し一撃↔makuri_pct+sashi_pct）の
 *    的中率と相関しているか（今は理由文の表示にしか使っていない）。
 * すべてtrain/testホールドアウトで再現するかまで確認する。
 */

type Rec = {
  label: string;
  hit: boolean;
  margin: number;
  likelyRank: number;
  bankPct: number | null; // そのシナリオに対応する決まり手の場割合(%)
  kaisaiDate: string;
};

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

  const records: Rec[] = [];
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scenarios.length < 2) return [];
        const { scenarios, race, venueKimarite, bankInfo } = prediction;
        const honmei = prediction.scored[0];
        const taikou = prediction.scored[1];
        const margin = taikou ? honmei.totalScore - taikou.totalScore : Infinity;

        const raceResults = await getResultsForRace(raceId);
        const odds = await getOddsForRace(raceId);
        const actualCombo = resolveActualCombo(raceResults, odds);
        if (actualCombo == null) return [];

        const nigePct = venueKimarite?.nige_pct ?? bankInfo?.nige_pct ?? null;
        const makuriSashiPct =
          venueKimarite != null
            ? venueKimarite.makuri_pct + venueKimarite.sashi_pct
            : bankInfo != null
              ? (bankInfo.makuri_pct ?? 0) + (bankInfo.sashi_pct ?? 0)
              : null;

        const recs: Rec[] = [];
        for (const scenario of scenarios) {
          if (scenario.label === "本命") continue; // 本命は今回の検証対象外（既に強いと分かっている）
          const bankPct =
            scenario.label === "逃げ粘り込み"
              ? nigePct
              : scenario.label === "まくり/差し一撃"
                ? makuriSashiPct
                : null;
          recs.push({
            label: scenario.label,
            hit: scenario.formation.combinations.includes(actualCombo),
            margin,
            likelyRank: scenario.likelyRank,
            bankPct,
            kaisaiDate: race.kaisai_date,
          });
        }
        return recs;
      })
    );
    for (const recs of results) records.push(...recs);
  }

  console.log(`\n判定対象（本命以外のシナリオ）: ${records.length}件\n`);

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  const trainAll = records.filter((r) => r.kaisaiDate < splitDate);
  const testAll = records.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`train=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}\n`);

  function hitRate(data: Rec[]): string {
    return data.length > 0 ? `${((data.filter((r) => r.hit).length / data.length) * 100).toFixed(1)}%(n=${data.length})` : "-";
  }

  // 1. margin別
  console.log("■ margin別 的中率（本命以外シナリオ合算）");
  const marginBuckets = [
    { label: "margin<3", filter: (r: Rec) => r.margin < 3 },
    { label: "3<=margin<8", filter: (r: Rec) => r.margin >= 3 && r.margin < 8 },
    { label: "margin>=8", filter: (r: Rec) => r.margin >= 8 },
  ];
  for (const b of marginBuckets) {
    console.log(`  [全体] ${b.label}: ${hitRate(records.filter(b.filter))}`);
  }
  console.log("  --- train/testホールドアウト ---");
  for (const b of marginBuckets) {
    console.log(`  ${b.label}: train ${hitRate(trainAll.filter(b.filter))} / test ${hitRate(testAll.filter(b.filter))}`);
  }

  // 2. likelyRank別
  console.log("\n■ likelyRank別 的中率（本命以外シナリオ合算）");
  for (const rank of [2, 3, 4]) {
    const data = records.filter((r) => r.likelyRank === rank);
    console.log(`  [全体] likelyRank=${rank}: ${hitRate(data)}`);
  }
  console.log("  --- train/testホールドアウト ---");
  for (const rank of [2, 3, 4]) {
    console.log(
      `  likelyRank=${rank}: train ${hitRate(trainAll.filter((r) => r.likelyRank === rank))} / test ${hitRate(testAll.filter((r) => r.likelyRank === rank))}`
    );
  }

  // 3. バンク決まり手傾向別（ラベルごとに見る）
  for (const label of ["逃げ粘り込み", "まくり/差し一撃"]) {
    const withPct = records.filter((r) => r.label === label && r.bankPct != null) as (Rec & { bankPct: number })[];
    if (withPct.length === 0) continue;
    const sorted = [...withPct].sort((a, b) => a.bankPct - b.bankPct);
    const median = sorted[Math.floor(sorted.length / 2)]?.bankPct ?? 0;
    console.log(`\n■ [${label}] バンク決まり手傾向別 的中率（中央値${median.toFixed(1)}%で分割）`);
    const low = withPct.filter((r) => r.bankPct < median);
    const high = withPct.filter((r) => r.bankPct >= median);
    console.log(`  [全体] 低: ${hitRate(low)} / 高: ${hitRate(high)}`);
    const trainL = trainAll.filter((r) => r.label === label && r.bankPct != null && (r as Rec & { bankPct: number }).bankPct < median);
    const trainH = trainAll.filter((r) => r.label === label && r.bankPct != null && (r as Rec & { bankPct: number }).bankPct >= median);
    const testL = testAll.filter((r) => r.label === label && r.bankPct != null && (r as Rec & { bankPct: number }).bankPct < median);
    const testH = testAll.filter((r) => r.label === label && r.bankPct != null && (r as Rec & { bankPct: number }).bankPct >= median);
    console.log(`  [train] 低: ${hitRate(trainL)} / 高: ${hitRate(trainH)}`);
    console.log(`  [test]  低: ${hitRate(testL)} / 高: ${hitRate(testH)}`);
  }
}

main();
