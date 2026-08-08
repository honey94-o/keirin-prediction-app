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
 * 「回収率をさらに上げる方法」の第一段階：新規スクレイピング不要で、既存データだけで
 * 検証できる仮説をチェックする。
 *
 * 仮説：現行の厳選ロジック（1日あたりmargin上位10件を採用）で選ばれるレースのうち、
 * 特定の開催場（jocd）やグレード（grade_kbn）に絞ると回収率が有意に上がる/下がるのでは。
 * もし特定の場・グレードで安定して回収率が高ければ、そこに絞ることでさらにROIが
 * 底上げできる可能性がある（逆に極端に悪い場・グレードを除外するだけでも効果がありうる）。
 *
 * scripts/simulate-selective-strategy.tsと同じ「日ごとにmargin上位10件」選定を再現し、
 * 選ばれたレースだけを対象に開催場別・グレード別に賭け金・払戻を集計する。
 */

interface RaceRecord {
  date: string;
  raceId: number;
  jocd: string;
  keirinjoName: string;
  grade: string;
  margin: number;
  stake: number;
  payout: number;
  hit: boolean;
}

const TOP_K = 10; // 現行の厳選ロジックと同じ

async function loadAllRaceRecords(): Promise<RaceRecord[]> {
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date, ra.jocd, ra.keirinjo_name, ra.grade_kbn FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    jocd: string;
    keirinjo_name: string;
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
          raceId: race.id,
          jocd: race.jocd,
          keirinjoName: race.keirinjo_name,
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
    const top = [...races].sort((a, b) => b.margin - a.margin).slice(0, TOP_K);
    selected.push(...top);
  }
  return selected;
}

interface GroupStat {
  races: number;
  hits: number;
  stake: number;
  payout: number;
}

function groupBy<T extends { stake: number; payout: number; hit: boolean }>(
  items: T[],
  keyFn: (item: T) => string
): Map<string, GroupStat> {
  const map = new Map<string, GroupStat>();
  for (const item of items) {
    const key = keyFn(item);
    const stat = map.get(key) ?? { races: 0, hits: 0, stake: 0, payout: 0 };
    stat.races++;
    if (item.hit) stat.hits++;
    stat.stake += item.stake;
    stat.payout += item.payout;
    map.set(key, stat);
  }
  return map;
}

function printGroup(title: string, map: Map<string, GroupStat>, minSample: number) {
  console.log(`\n${title}（サンプル${minSample}件未満は参考値扱い）:`);
  const rows = [...map.entries()]
    .map(([key, s]) => ({
      key,
      ...s,
      roi: s.stake > 0 ? (s.payout / s.stake) * 100 : NaN,
      hitRate: s.races > 0 ? (s.hits / s.races) * 100 : NaN,
    }))
    .sort((a, b) => b.roi - a.roi);
  for (const r of rows) {
    const note = r.races < minSample ? "  ※参考値" : "";
    console.log(
      `  ${r.key.padEnd(10)}: 回収率${r.roi.toFixed(1)}% / 的中率${r.hitRate.toFixed(1)}% ` +
        `(${r.hits}/${r.races}件, 賭け金${r.stake}円, 払戻${r.payout.toFixed(0)}円)${note}`
    );
  }
}

async function main() {
  const all = await loadAllRaceRecords();
  console.log(`predictRace成功: ${all.length}件`);

  const selected = selectDaily(all);
  const totalStake = selected.reduce((s, r) => s + r.stake, 0);
  const totalPayout = selected.reduce((s, r) => s + r.payout, 0);
  console.log(
    `\n厳選（日次margin上位${TOP_K}件）選定レース: ${selected.length}件 / ` +
      `全体回収率${((totalPayout / totalStake) * 100).toFixed(1)}%\n`
  );

  const byVenue = groupBy(selected, (r) => `${r.keirinjoName}(${r.jocd})`);
  printGroup("■ 開催場別", byVenue, 15);

  const byGrade = groupBy(selected, (r) => r.grade);
  printGroup("■ グレード別", byGrade, 15);
}

main();
