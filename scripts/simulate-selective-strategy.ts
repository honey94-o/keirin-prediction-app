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

/**
 * ユーザー依頼：「1日5〜10レース・1レース20点以内」に絞った厳選買い戦略を、
 * 過去データ全件でシミュレーションし、30日ローリング窓の回収率がどれだけ
 * 安定して100%を超えるかを検証する。
 *
 * 買い目は「本命」シナリオのみ（1レースにつき単一の3連単フォーメーション、
 * generateScenariosの動的な点数付け＝通常2点/高信頼度時20点/拮抗時ボックスが
 * そのまま「1レース20点以内」を満たす）。選び方は「その日の本命margin
 * （◎と対抗のスコア差）が大きい順に上位N件」。marginの足切りライン
 * （MIN_MARGIN）と1日の採用件数（TOP_K）を変えて、どの設定が一番安定して
 * 30日回収率100%超を達成できるか比較する。
 *
 * 全レースを1回だけpredictRaceして日付ごとにキャッシュし、複数の戦略設定を
 * 同じデータに対して繰り返し評価することで、何度もDBを読み直さずに済むようにする。
 */

interface RaceRecord {
  date: string;
  raceId: number;
  margin: number;
  stake: number;
  payout: number;
  hit: boolean;
}

async function loadAllRaceRecords(): Promise<RaceRecord[]> {
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string }[];
  console.log(`対象レース: ${races.length}件`);

  const records: RaceRecord[] = [];
  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 2) return null;
        const { scored, scenarios } = prediction;
        const honmeiScenario = scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario) return null;

        const raceResults = await getResultsForRace(race.id);
        const top3 = raceResults
          .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
          .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
        if (top3.length < 3) return null;

        const odds = (await getOddsForRace(race.id)).filter((o) => o.bet_type === "3連単");
        const distinctCombos = new Set(odds.map((o) => o.combination));
        const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
        const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");
        const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

        const margin = scored[0].totalScore - scored[1].totalScore;
        const stake = 100 * honmeiScenario.formation.combinations.length;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;

        const rec: RaceRecord = { date: race.kaisai_date, raceId: race.id, margin, stake, payout, hit };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    if ((i / BATCH) % 10 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, races.length)}/${races.length}`);
  }
  return records;
}

function evaluateStrategy(
  records: RaceRecord[],
  minMargin: number,
  topK: number
): { dailyStake: Map<string, number>; dailyPayout: Map<string, number>; dailyCount: Map<string, number> } {
  const byDate = new Map<string, RaceRecord[]>();
  for (const r of records) {
    if (r.margin < minMargin) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }

  const dailyStake = new Map<string, number>();
  const dailyPayout = new Map<string, number>();
  const dailyCount = new Map<string, number>();

  for (const [date, races] of byDate) {
    const selected = [...races].sort((a, b) => b.margin - a.margin).slice(0, topK);
    let stake = 0;
    let payout = 0;
    for (const r of selected) {
      stake += r.stake;
      payout += r.payout;
    }
    dailyStake.set(date, stake);
    dailyPayout.set(date, payout);
    dailyCount.set(date, selected.length);
  }

  return { dailyStake, dailyPayout, dailyCount };
}

function rollingWindowStats(
  allDates: string[],
  dailyStake: Map<string, number>,
  dailyPayout: Map<string, number>,
  windowDays: number
): { windows: number; above100: number; minRoi: number; maxRoi: number; avgRoi: number; overallRoi: number } {
  let windows = 0;
  let above100 = 0;
  let minRoi = Infinity;
  let maxRoi = -Infinity;
  let roiSum = 0;

  let totalStake = 0;
  let totalPayout = 0;

  for (let i = 0; i + windowDays <= allDates.length; i++) {
    const windowDates = allDates.slice(i, i + windowDays);
    let stake = 0;
    let payout = 0;
    for (const d of windowDates) {
      stake += dailyStake.get(d) ?? 0;
      payout += dailyPayout.get(d) ?? 0;
    }
    if (stake === 0) continue; // 賭けていない窓はスキップ（対象外）
    const roi = (payout / stake) * 100;
    windows++;
    if (roi >= 100) above100++;
    minRoi = Math.min(minRoi, roi);
    maxRoi = Math.max(maxRoi, roi);
    roiSum += roi;
  }

  for (const d of allDates) {
    totalStake += dailyStake.get(d) ?? 0;
    totalPayout += dailyPayout.get(d) ?? 0;
  }

  return {
    windows,
    above100,
    minRoi: windows > 0 ? minRoi : NaN,
    maxRoi: windows > 0 ? maxRoi : NaN,
    avgRoi: windows > 0 ? roiSum / windows : NaN,
    overallRoi: totalStake > 0 ? (totalPayout / totalStake) * 100 : NaN,
  };
}

async function main() {
  const records = await loadAllRaceRecords();
  console.log(`\npredictRace成功: ${records.length}件`);

  const allDates = [...new Set(records.map((r) => r.date))].sort();
  console.log(`対象日数: ${allDates.length}日（${allDates[0]} 〜 ${allDates[allDates.length - 1]}）\n`);

  const marginCandidates = [0, 5, 10, 15, 20, 25];
  const topKCandidates = [5, 10];

  console.log("minMargin | topK | 平均採用数/日 | 全期間回収率 | 30日窓: 平均/最小/最大 | 100%超えの窓割合");
  for (const minMargin of marginCandidates) {
    for (const topK of topKCandidates) {
      const { dailyStake, dailyPayout, dailyCount } = evaluateStrategy(records, minMargin, topK);
      const activeDays = [...dailyCount.values()].filter((c) => c > 0).length;
      const avgCount =
        activeDays > 0
          ? [...dailyCount.values()].reduce((a, b) => a + b, 0) / activeDays
          : 0;
      const stats = rollingWindowStats(allDates, dailyStake, dailyPayout, 30);
      console.log(
        `margin>=${minMargin} | top${topK} | ${avgCount.toFixed(1)}件/日(稼働${activeDays}日) | ` +
          `${stats.overallRoi.toFixed(1)}% | 窓平均${stats.avgRoi.toFixed(1)}% 最小${stats.minRoi.toFixed(1)}% 最大${stats.maxRoi.toFixed(1)}% | ` +
          `${stats.windows > 0 ? ((stats.above100 / stats.windows) * 100).toFixed(1) : "-"}% (${stats.above100}/${stats.windows}窓)`
      );
    }
  }
}

main();
