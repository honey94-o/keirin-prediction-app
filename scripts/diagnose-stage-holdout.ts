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
import { getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";

/**
 * diagnose-stage-raceno-noline.tsで「予選だけROIが低い(98.9%)、決勝・選抜特選・
 * 一般は125〜137%」という結果が出たが、開催場フィルタ（Ninth finding）と同じ
 * 「複数カテゴリを同時比較する」構造のため過学習の可能性がある。前半/後半で
 * アウトオブサンプル検証する。
 */

function stageOf(syumoku: string | null): string {
  if (!syumoku) return "不明";
  if (/決勝/.test(syumoku) && !/準々|準決/.test(syumoku)) return "決勝";
  if (/準決勝/.test(syumoku)) return "準決勝";
  if (/準々決勝/.test(syumoku)) return "準々決勝";
  if (/選抜|特選/.test(syumoku)) return "選抜・特選";
  if (/予選/.test(syumoku)) return "予選";
  if (/一般/.test(syumoku)) return "一般";
  return "その他";
}

interface Rec {
  date: string;
  stage: string;
  stake: number;
  payout: number;
  hit: boolean;
}

async function main() {
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date, ra.syumoku FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string; syumoku: string | null }[];
  console.log(`対象レース: ${races.length}件`);

  const records: Rec[] = [];
  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 2) return null;
        const { scenarios } = prediction;
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

        const stake = 100 * honmeiScenario.formation.combinations.length;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;

        const rec: Rec = { date: race.kaisai_date, stage: stageOf(race.syumoku), stake, payout, hit };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const trainDates = new Set(dates.slice(0, splitIdx));
  const testDates = new Set(dates.slice(splitIdx));

  const train = records.filter((r) => trainDates.has(r.date));
  const test = records.filter((r) => testDates.has(r.date));

  function roiOf(recs: Rec[]) {
    const stake = recs.reduce((s, r) => s + r.stake, 0);
    const payout = recs.reduce((s, r) => s + r.payout, 0);
    return { roi: stake > 0 ? (payout / stake) * 100 : NaN, stake, n: recs.length };
  }

  console.log(
    `\n学習期間: ${dates[0]} 〜 ${dates[splitIdx - 1]} (${trainDates.size}日, ${train.length}件) ROI ${roiOf(train).roi.toFixed(1)}%`
  );
  console.log(
    `検証期間: ${dates[splitIdx]} 〜 ${dates[dates.length - 1]} (${testDates.size}日, ${test.length}件) ROI ${roiOf(test).roi.toFixed(1)}%`
  );

  const stages = [...new Set(records.map((r) => r.stage))];
  console.log(`\n■ ステージ別（学習期間ROI → 検証期間ROI）:`);
  for (const stage of stages) {
    const tr = roiOf(train.filter((r) => r.stage === stage));
    const te = roiOf(test.filter((r) => r.stage === stage));
    console.log(
      `  ${stage}: 学習 ${isNaN(tr.roi) ? "-" : tr.roi.toFixed(1) + "%"} (n=${tr.n}) → 検証 ${isNaN(te.roi) ? "-" : te.roi.toFixed(1) + "%"} (n=${te.n})`
    );
  }

  // 予選を除外した場合の検証期間ROI
  const baseTest = roiOf(test);
  const excludedTest = roiOf(test.filter((r) => r.stage !== "予選"));
  console.log(
    `\n[予選を除外] 検証期間ROI ${excludedTest.roi.toFixed(1)}% (n=${excludedTest.n}) ※フィルタなし${baseTest.roi.toFixed(1)}%と比較`
  );
}

main();
