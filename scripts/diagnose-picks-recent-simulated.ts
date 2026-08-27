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
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * 中間帯を2点→6点に広げた「今のロジック」で、厳選レース（日次margin上位10件）の
 * 直近ROIを再計算する。daily_picksテーブルの過去スナップショットは変更前の
 * ロジックのまま残っているため、ユーザーの「直近の回収率は？」に正しく
 * 答えるにはpredictRaceで今のロジックを使って再計算する必要がある。
 */

const TOP_K = 10;
const DAYS = Number(process.argv[2] ?? 30);

interface RaceRecord {
  date: string;
  margin: number;
  stake: number;
  payout: number;
  hit: boolean;
}

async function main() {
  enableReadCache();

  const today = todayJstStr();
  const sinceDate = addDaysToDateStr(today, -DAYS);

  const db = getDb();
  const raceRows = await db.execute({
    sql: `SELECT ra.id, ra.kaisai_date FROM races ra
          JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
          WHERE ra.kaisai_date >= ? AND ra.kaisai_date < ?
          ORDER BY ra.kaisai_date, ra.id`,
    args: [sinceDate, today],
  });
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string }[];
  console.log(`対象期間: ${sinceDate} 〜 ${today} (直近${DAYS}日) / 結果確定レース: ${races.length}件`);

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

        const rec: RaceRecord = { date: race.kaisai_date, margin, stake, payout, hit };
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

  console.log("\n日付 | 件数 | 的中 | 賭け金 | 払戻 | 日次回収率");
  let totalStake = 0;
  let totalPayout = 0;
  let totalHits = 0;
  for (const [date, _] of [...byDate.entries()].sort()) {
    const dayPicks = selected.filter((r) => r.date === date);
    if (dayPicks.length === 0) continue;
    const stake = dayPicks.reduce((s, r) => s + r.stake, 0);
    const payout = dayPicks.reduce((s, r) => s + r.payout, 0);
    const hits = dayPicks.filter((r) => r.hit).length;
    console.log(
      `${date}: ${dayPicks.length}件 ${hits}的中 ${stake}円 ${payout.toFixed(0)}円 ${((payout / stake) * 100).toFixed(1)}%`
    );
    totalStake += stake;
    totalPayout += payout;
    totalHits += hits;
  }

  console.log(`\n■ 対象: ${selected.length}件 / 的中: ${totalHits}件 (${((totalHits / selected.length) * 100).toFixed(1)}%)`);
  console.log(`賭け金合計: ${totalStake}円 / 払戻合計: ${totalPayout.toFixed(0)}円`);
  console.log(`■ 全体回収率（現行ロジックで再計算）: ${((totalPayout / totalStake) * 100).toFixed(1)}%`);
}

main();
