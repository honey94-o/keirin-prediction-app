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

// lib/scoring.tsのLOW_MARGIN_THRESHOLDはexportされていないため値をここに複製する
// （scoring.ts内の定義: const LOW_MARGIN_THRESHOLD = 5;）。
const LOW_MARGIN_THRESHOLD = 5;

// 中間帯（LOW_MARGIN_THRESHOLD<=margin<HIGH_CONFIDENCE_MARGIN）に絞って、
// 高信頼度帯と同じ「フォーメーション点数を広げたらROIは改善するか」を検証する。
// 「毎日margin上位10件」に選ばれたレースのうち、この中間帯だけが対象。

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

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string }[];

  type Rec = {
    date: string;
    margin: number;
    honmeiCarNum: number;
    pool: number[];
    actualCombo: string;
    hitOdds: number | null;
  };
  const records: Rec[] = [];

  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 2) return null;
        const { scored } = prediction;
        const honmei = scored[0];
        const taikou = scored[1];
        const margin = honmei.totalScore - taikou.totalScore;

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

        const pool = scored
          .filter((s) => s.entry.car_num !== honmei.entry.car_num)
          .sort((a, b) => b.totalScore - a.totalScore)
          .map((s) => s.entry.car_num);

        const rec: Rec = { date: race.kaisai_date, margin, honmeiCarNum: honmei.entry.car_num, pool, actualCombo, hitOdds };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }
  console.log(`predictRace成功: ${records.length}件`);

  // 「毎日margin上位10件」の選定を再現
  const byDate = new Map<string, Rec[]>();
  for (const r of records) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const selected: Rec[] = [];
  for (const [, races] of byDate) {
    const top10 = [...races].sort((a, b) => b.margin - a.margin).slice(0, 10);
    selected.push(...top10);
  }

  const midBand = selected.filter((r) => r.margin >= LOW_MARGIN_THRESHOLD && r.margin < HIGH_CONFIDENCE_MARGIN);
  console.log(`選定レース中、中間帯(${LOW_MARGIN_THRESHOLD}<=margin<${HIGH_CONFIDENCE_MARGIN})の母数: ${midBand.length}件\n`);

  console.log("点数 | 的中率 | 回収率 | 賭け金 | 払戻");
  for (const budget of CANDIDATE_BUDGETS) {
    let stake = 0;
    let payout = 0;
    let hits = 0;
    for (const r of midBand) {
      const combos = formationFromPool(r.honmeiCarNum, r.pool, budget);
      stake += 100 * combos.length;
      const hit = combos.includes(r.actualCombo);
      if (hit) {
        hits++;
        if (r.hitOdds != null) payout += 100 * r.hitOdds;
      }
    }
    const hitRate = ((hits / midBand.length) * 100).toFixed(1);
    const roi = stake > 0 ? ((payout / stake) * 100).toFixed(1) : "-";
    console.log(`budget=${budget}: 的中率${hitRate}% (${hits}/${midBand.length}) 回収率${roi}% (賭け金${stake}円/払戻${payout.toFixed(0)}円)`);
  }
}

main();
