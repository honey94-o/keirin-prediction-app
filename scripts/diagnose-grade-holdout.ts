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

/**
 * diagnose-venue-holdout.ts と同じ手法（前半=学習/後半=検証のアウトオブサンプル検証）
 * をグレード区分（grade_kbn）に適用する。開催場は40近い候補があり多重比較で
 * 過学習しやすいことが確認できたが、グレードはF1/F2/G1/G2/G3程度と候補が少なく
 * F2・F1はサンプルも大きいため、こちらは本物のシグナルとして残る可能性がある。
 */

interface RaceRecord {
  date: string;
  grade: string;
  margin: number;
  stake: number;
  payout: number;
  hit: boolean;
}

const TOP_K = 10;

async function loadAllRaceRecords(): Promise<RaceRecord[]> {
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date, ra.grade_kbn FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    grade_kbn: string | null;
  }[];
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

        const rec: RaceRecord = {
          date: race.kaisai_date,
          grade: race.grade_kbn ?? "不明",
          margin,
          stake,
          payout,
          hit,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }
  return records;
}

function selectDaily(records: RaceRecord[]): RaceRecord[] {
  const byDate = new Map<string, RaceRecord[]>();
  for (const r of records) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const selected: RaceRecord[] = [];
  for (const races of byDate.values()) {
    selected.push(...[...races].sort((a, b) => b.margin - a.margin).slice(0, TOP_K));
  }
  return selected;
}

function roiOf(records: RaceRecord[]): { roi: number; stake: number; payout: number; n: number } {
  const stake = records.reduce((s, r) => s + r.stake, 0);
  const payout = records.reduce((s, r) => s + r.payout, 0);
  return { roi: stake > 0 ? (payout / stake) * 100 : NaN, stake, payout, n: records.length };
}

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const all = await loadAllRaceRecords();
  const selected = selectDaily(all);

  const dates = [...new Set(selected.map((r) => r.date))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const trainDates = new Set(dates.slice(0, splitIdx));
  const testDates = new Set(dates.slice(splitIdx));

  const train = selected.filter((r) => trainDates.has(r.date));
  const test = selected.filter((r) => testDates.has(r.date));

  const baseTrain = roiOf(train);
  const baseTest = roiOf(test);
  console.log(
    `\n学習期間: ${dates[0]} 〜 ${dates[splitIdx - 1]} (${trainDates.size}日, ${train.length}件) ROI ${baseTrain.roi.toFixed(1)}%`
  );
  console.log(
    `検証期間: ${dates[splitIdx]} 〜 ${dates[dates.length - 1]} (${testDates.size}日, ${test.length}件) ROI ${baseTest.roi.toFixed(1)}%`
  );

  const grades = [...new Set(selected.map((r) => r.grade))];
  console.log(`\n■ グレード別（学習期間ROI → 検証期間ROI）:`);
  for (const g of grades) {
    const tr = roiOf(train.filter((r) => r.grade === g));
    const te = roiOf(test.filter((r) => r.grade === g));
    console.log(
      `  ${g.padEnd(4)}: 学習 ${isNaN(tr.roi) ? "-" : tr.roi.toFixed(1) + "%"} (n=${tr.n}) → ` +
        `検証 ${isNaN(te.roi) ? "-" : te.roi.toFixed(1) + "%"} (n=${te.n})`
    );
  }

  // 学習期間ROIが低いグレードを除外した場合の検証期間ROI
  for (const dropGrade of grades) {
    const filteredTest = test.filter((r) => r.grade !== dropGrade);
    const stat = roiOf(filteredTest);
    console.log(
      `\n[${dropGrade}を除外] 検証期間ROI ${stat.roi.toFixed(1)}% (n=${stat.n}) ` +
        `※フィルタなし ${baseTest.roi.toFixed(1)}%と比較`
    );
  }
}

main();
