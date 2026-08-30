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
import { HIGH_CONFIDENCE_MARGIN } from "../lib/scoring";

const LOW_MARGIN_THRESHOLD = 5;
const TOP_K = 10;

/**
 * 厳選レース（日次margin上位10件）の現行ロジックでのROIを、margin帯
 * （高信頼度/中間帯/拮抗＝ボックス）別に分解する。中間帯を6点に広げた後、
 * 全体ROIがまだ100%を切っている（直近30日79.1%）ため、次にどの帯が
 * 弱いのかを特定する。
 */

interface RaceRecord {
  date: string;
  margin: number;
  band: string;
  stake: number;
  payout: number;
  hit: boolean;
}

async function main() {
  enableReadCache();

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
        const band =
          margin >= HIGH_CONFIDENCE_MARGIN ? "高信頼度(>=10)" : margin < LOW_MARGIN_THRESHOLD ? "拮抗(<5,box)" : "中間帯(5-10)";
        const stake = 100 * honmeiScenario.formation.combinations.length;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;

        const rec: RaceRecord = { date: race.kaisai_date, margin, band, stake, payout, hit };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }

  const byDate = new Map<string, RaceRecord[]>();
  for (const r of records) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const selected: RaceRecord[] = [];
  for (const dayRaces of byDate.values()) {
    selected.push(...[...dayRaces].sort((a, b) => b.margin - a.margin).slice(0, TOP_K));
  }

  console.log(`\n厳選（日次margin上位${TOP_K}件）選定レース: ${selected.length}件`);
  const totalStake = selected.reduce((s, r) => s + r.stake, 0);
  const totalPayout = selected.reduce((s, r) => s + r.payout, 0);
  console.log(`全体回収率: ${((totalPayout / totalStake) * 100).toFixed(1)}%\n`);

  console.log("帯 | 件数 | 割合 | 的中率 | 賭け金 | 払戻 | 回収率");
  const bands = ["高信頼度(>=10)", "中間帯(5-10)", "拮抗(<5,box)"];
  for (const band of bands) {
    const recs = selected.filter((r) => r.band === band);
    if (recs.length === 0) continue;
    const stake = recs.reduce((s, r) => s + r.stake, 0);
    const payout = recs.reduce((s, r) => s + r.payout, 0);
    const hits = recs.filter((r) => r.hit).length;
    console.log(
      `${band}: ${recs.length}件 (${((recs.length / selected.length) * 100).toFixed(1)}%) ` +
        `的中率${((hits / recs.length) * 100).toFixed(1)}% (${hits}/${recs.length}) ` +
        `賭け金${stake}円 払戻${payout.toFixed(0)}円 回収率${((payout / stake) * 100).toFixed(1)}%`
    );
  }

  // 直近30日だけの内訳も見る
  const dates = [...byDate.keys()].sort();
  const recentDates = new Set(dates.slice(-30));
  const recentSelected = selected.filter((r) => recentDates.has(r.date));
  console.log(`\n■ 直近30日（${dates.slice(-30)[0]}〜${dates[dates.length - 1]}）内訳:`);
  for (const band of bands) {
    const recs = recentSelected.filter((r) => r.band === band);
    if (recs.length === 0) continue;
    const stake = recs.reduce((s, r) => s + r.stake, 0);
    const payout = recs.reduce((s, r) => s + r.payout, 0);
    const hits = recs.filter((r) => r.hit).length;
    console.log(
      `${band}: ${recs.length}件 的中率${((hits / recs.length) * 100).toFixed(1)}% ` +
        `賭け金${stake}円 払戻${payout.toFixed(0)}円 回収率${((payout / stake) * 100).toFixed(1)}%`
    );
  }
}

main();
