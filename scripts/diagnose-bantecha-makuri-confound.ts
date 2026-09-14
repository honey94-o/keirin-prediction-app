import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

/**
 * 【検証結果: 交絡ではない（diagnose-bantecha-makuri.ts参照）】
 * 番手の脚質（逃/両 vs 追）が自ラインの先頭を上回る率に与える効果が、
 * 既に参考表示採用済みのstanding_count（好スタート回数、db/schema.sql・
 * STANDING_COUNT_HIGH_THRESHOLD参照）の言い換えに過ぎないのではないかを確認する。
 *
 * 結果: standing_countの3分位で層別しても、逃/両 vs 追 の差は各層で残った
 * （低位帯51.4%対46.3%、中位帯54.3%対49.8%、高位帯59.3%対49.0%、
 * いずれもtrain/testで再現）。標準starting_countが高いほどむしろ差が
 * 拡大する（高位帯で+10.3pt）ため、単なる代理変数ではなく独立した信号と判断。
 */

type Rec = { kyakushitsu: string | null; standingCount: number; overtook: boolean; date: string };

async function main() {
  const db = getDb();
  const entRes = await db.execute(`
    SELECT e.race_id, e.car_num, e.line_group, e.line_position, r.kyakushitsu, r.standing_count, ra.kaisai_date
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%' AND e.line_position IS NOT NULL
  `);
  type EntRow = {
    race_id: number;
    car_num: number;
    line_group: number | null;
    line_position: string;
    kyakushitsu: string | null;
    standing_count: number | null;
    kaisai_date: string;
  };
  const rows = entRes.rows as unknown as EntRow[];
  const byRace = new Map<number, EntRow[]>();
  for (const e of rows) {
    const a = byRace.get(e.race_id) ?? [];
    a.push(e);
    byRace.set(e.race_id, a);
  }
  const raceIds = [...byRace.keys()];

  const resultsRows: { race_id: number; car_num: number; finish_pos: number }[] = [];
  const CHUNK = 2000;
  for (let i = 0; i < raceIds.length; i += CHUNK) {
    const chunk = raceIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT race_id, car_num, finish_pos FROM results WHERE race_id IN (${placeholders}) AND finish_pos IS NOT NULL`,
      args: chunk,
    });
    resultsRows.push(...(r.rows as unknown as { race_id: number; car_num: number; finish_pos: number }[]));
  }
  const finishByRaceCar = new Map<string, number>();
  for (const r of resultsRows) finishByRaceCar.set(`${r.race_id}:${r.car_num}`, r.finish_pos);

  const records: Rec[] = [];
  for (const [raceId, entries] of byRace) {
    const lineGroups = new Map<number, EntRow[]>();
    for (const e of entries) {
      if (e.line_group == null) continue;
      const a = lineGroups.get(e.line_group) ?? [];
      a.push(e);
      lineGroups.set(e.line_group, a);
    }
    for (const members of lineGroups.values()) {
      const senko = members.find((m) => m.line_position === "先頭");
      const bantesu = members.find((m) => m.line_position === "番手");
      if (!senko || !bantesu || bantesu.standing_count == null) continue;
      const senkoFinish = finishByRaceCar.get(`${raceId}:${senko.car_num}`);
      const bantesuFinish = finishByRaceCar.get(`${raceId}:${bantesu.car_num}`);
      if (senkoFinish == null || bantesuFinish == null) continue;
      records.push({
        kyakushitsu: bantesu.kyakushitsu,
        standingCount: bantesu.standing_count,
        overtook: bantesuFinish < senkoFinish,
        date: bantesu.kaisai_date,
      });
    }
  }
  console.log(`対象(standing_count判明分): ${records.length}件\n`);

  const sorted = [...records].sort((a, b) => a.standingCount - b.standingCount);
  const t1 = sorted[Math.floor(sorted.length / 3)].standingCount;
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)].standingCount;
  const tierOf = (sc: number) => (sc <= t1 ? "低" : sc <= t2 ? "中" : "高");

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  function rate(data: Rec[]): string {
    return data.length ? ((100 * data.filter((r) => r.overtook).length) / data.length).toFixed(1) + "%" : "-";
  }

  for (const tier of ["低", "中", "高"]) {
    const inTier = records.filter((r) => tierOf(r.standingCount) === tier);
    const nigeRyo = inTier.filter((r) => r.kyakushitsu === "逃" || r.kyakushitsu === "両");
    const oi = inTier.filter((r) => r.kyakushitsu === "追");
    console.log(`--- standing_count ${tier}位帯 (n=${inTier.length}) ---`);
    console.log(`  逃/両: 全体${rate(nigeRyo)} train${rate(nigeRyo.filter((r) => r.date < split))} test${rate(nigeRyo.filter((r) => r.date >= split))}`);
    console.log(`  追  : 全体${rate(oi)} train${rate(oi.filter((r) => r.date < split))} test${rate(oi.filter((r) => r.date >= split))}`);
  }
}

main();
