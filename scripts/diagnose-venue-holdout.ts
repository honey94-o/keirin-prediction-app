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
 * scripts/diagnose-venue-grade-roi.ts で「特定の開催場に絞ると回収率が上がりそう」
 * という仮説が出たが、40近い開催場を同時に比較しているため多重比較で偶然良く
 * 見えているだけの場が混ざっている可能性が高い（高知3件で1149%等）。
 *
 * ここでは開催期間を前半（学習期間）・後半（検証期間）に分割し、
 * 「前半のデータだけを見て開催場を選び、後半のデータで実際にROIが上がるか」を
 * 検証する（時系列アウトオブサンプル検証）。これが崩れる=過学習、
 * 後半でも効果が残る=本物のシグナルの可能性が高い、と判断する。
 */

interface RaceRecord {
  date: string;
  jocd: string;
  keirinjoName: string;
  margin: number;
  stake: number;
  payout: number;
  hit: boolean;
}

const TOP_K = 10;
const MIN_TRAIN_SAMPLE = 15;

async function loadAllRaceRecords(): Promise<RaceRecord[]> {
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date, ra.jocd, ra.keirinjo_name FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    jocd: string;
    keirinjo_name: string;
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
          jocd: race.jocd,
          keirinjoName: race.keirinjo_name,
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
  const all = await loadAllRaceRecords();
  const selected = selectDaily(all);

  const dates = [...new Set(selected.map((r) => r.date))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const trainDates = new Set(dates.slice(0, splitIdx));
  const testDates = new Set(dates.slice(splitIdx));

  const train = selected.filter((r) => trainDates.has(r.date));
  const test = selected.filter((r) => testDates.has(r.date));

  console.log(
    `\n学習期間: ${dates[0]} 〜 ${dates[splitIdx - 1]} (${trainDates.size}日, ${train.length}件)`
  );
  console.log(
    `検証期間: ${dates[splitIdx]} 〜 ${dates[dates.length - 1]} (${testDates.size}日, ${test.length}件)`
  );

  const baseTrain = roiOf(train);
  const baseTest = roiOf(test);
  console.log(`\n[フィルタなし] 学習期間ROI: ${baseTrain.roi.toFixed(1)}% / 検証期間ROI: ${baseTest.roi.toFixed(1)}%`);

  // 学習期間だけを見て開催場別ROIを算出し、サンプル数十分な場をROI順に並べる
  const byVenueTrain = new Map<string, RaceRecord[]>();
  for (const r of train) {
    const key = r.jocd;
    const arr = byVenueTrain.get(key) ?? [];
    arr.push(r);
    byVenueTrain.set(key, arr);
  }
  const venueStatsTrain = [...byVenueTrain.entries()]
    .map(([jocd, recs]) => ({ jocd, name: recs[0].keirinjoName, ...roiOf(recs) }))
    .filter((v) => v.n >= MIN_TRAIN_SAMPLE)
    .sort((a, b) => b.roi - a.roi);

  console.log(`\n学習期間で十分なサンプル(n>=${MIN_TRAIN_SAMPLE})がある場: ${venueStatsTrain.length}場`);
  for (const v of venueStatsTrain) {
    console.log(`  ${v.name}(${v.jocd}): 学習期間ROI ${v.roi.toFixed(1)}% (n=${v.n})`);
  }

  // 上位K場だけに絞ったら検証期間のROIはどうなるか（K=3,5,8,10で試す）
  console.log(`\n■ 学習期間ROI上位K場だけに絞った場合の検証期間ROI:`);
  for (const k of [3, 5, 8, 10]) {
    const topJocds = new Set(venueStatsTrain.slice(0, k).map((v) => v.jocd));
    const filteredTest = test.filter((r) => topJocds.has(r.jocd));
    const stat = roiOf(filteredTest);
    console.log(
      `  上位${k}場 [${venueStatsTrain.slice(0, k).map((v) => v.name).join(",")}]: ` +
        `検証期間ROI ${stat.roi.toFixed(1)}% (n=${stat.n}, 賭け金${stat.stake}円)`
    );
  }

  // 学習期間ROIが100%未満だった場を除外したら検証期間のROIは改善するか
  const badJocds = new Set(venueStatsTrain.filter((v) => v.roi < 100).map((v) => v.jocd));
  const excludedTest = test.filter((r) => !badJocds.has(r.jocd));
  const excludedStat = roiOf(excludedTest);
  console.log(
    `\n■ 学習期間ROI<100%の場(${badJocds.size}場)を除外: 検証期間ROI ${excludedStat.roi.toFixed(1)}% ` +
      `(n=${excludedStat.n}, 元の検証期間ROI ${baseTest.roi.toFixed(1)}%と比較)`
  );
}

main();
