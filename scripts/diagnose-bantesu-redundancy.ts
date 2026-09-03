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

/**
 * diagnose-line-position-history.tsで見つかった「番手選手の番手時勝率」信号が、
 * 既存のcalculatePositionWinRateScore（calculateStatsScoreに重み0.2で既に混ぜて
 * いる、同じ発想の指標）や、単に「番手選手の方が先頭より地力が高いだけ」の
 * 焼き直しでないかを確認する（軽量・predictRaceは使わずSQL+JSのみ）。
 *
 * heikin_tokuten（平均得点）で番手が先頭より地力上か下かで層別し、
 * 各層の中でも番手時勝率バケットの効果が残るかを見る。
 */

type Row = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  finish_pos: number;
  heikin_tokuten: number | null;
};

function bucketLabel(rate: number, cuts: number[]): string {
  if (rate < cuts[0]) return "低";
  if (rate < cuts[1]) return "中";
  return "高";
}

async function main() {
  const db = getDb();
  const entriesResult = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, e.line_position, r.finish_pos,
           rc.heikin_tokuten
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY e.race_id
  `);
  const rows = entriesResult.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  type PosStat = { races: number; wins: number };
  const globalStats = new Map<string, PosStat>();
  for (const r of rows) {
    if (!r.line_position) continue;
    const key = `${r.snum}:${r.line_position}`;
    const s = globalStats.get(key) ?? { races: 0, wins: 0 };
    s.races++;
    if (r.finish_pos === 1) s.wins++;
    globalStats.set(key, s);
  }
  function priorWinRate(snum: string, position: string, excludeFinishPos: number): { rate: number; n: number } | null {
    const s = globalStats.get(`${snum}:${position}`);
    if (!s) return null;
    const races = s.races - 1;
    if (races <= 0) return null;
    let wins = s.wins;
    if (excludeFinishPos === 1) wins--;
    return { rate: (wins / races) * 100, n: races };
  }

  const byRaceLine = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.line_group == null) continue;
    const key = `${r.race_id}:${r.line_group}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(r);
    byRaceLine.set(key, arr);
  }

  const MIN_N = 5;
  // stratum: "番手が地力上"(heikin_tokuten番手>先頭) or "番手が地力下"
  const strata: Record<string, Record<string, { n: number; bantesuAhead: number }>> = {
    "番手が地力上": {},
    "番手が地力下": {},
  };

  for (const [, members] of byRaceLine) {
    const senko = members.find((m) => m.line_position === "先頭");
    const bantesu = members.find((m) => m.line_position === "番手");
    if (!senko || !bantesu) continue;
    if (senko.heikin_tokuten == null || bantesu.heikin_tokuten == null) continue;
    const bantesuAhead = bantesu.finish_pos < senko.finish_pos;
    const stratum = bantesu.heikin_tokuten > senko.heikin_tokuten ? "番手が地力上" : "番手が地力下";

    const bWin = priorWinRate(bantesu.snum, "番手", bantesu.finish_pos);
    if (!bWin || bWin.n < MIN_N) continue;
    const bucket = bucketLabel(bWin.rate, [10, 20]);
    const s = strata[stratum][bucket] ?? { n: 0, bantesuAhead: 0 };
    s.n++;
    if (bantesuAhead) s.bantesuAhead++;
    strata[stratum][bucket] = s;
  }

  for (const stratumName of ["番手が地力上", "番手が地力下"]) {
    console.log(`\n■ ${stratumName}（heikin_tokutenで比較）の中での番手時勝率バケット別 → 番手が先頭より上位で入線した率`);
    for (const bucket of ["低", "中", "高"]) {
      const s = strata[stratumName][bucket];
      if (!s) {
        console.log(`  ${bucket}: データ不足`);
        continue;
      }
      console.log(`  ${bucket}: ${((s.bantesuAhead / s.n) * 100).toFixed(1)}% (${s.bantesuAhead}/${s.n})`);
    }
  }
}

main();
