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
 * ユーザー仮説の検証：選手個人の「隊列内位置別・自分の着順傾向」が、
 * そのレースのライン内での実際の決着パターン（先頭が逃げ切るか差されるか、
 * ラインが3着内独占できるか）を予測できるか。
 *
 * 「以前選手の当たり不当たりの傾向×隊列位置」を混ぜたマーク率/差し率での
 * 試み（六番目の発見、kimarite_*_count由来）は失敗しているが、今回は
 * 着順そのものの履歴（1着/2着/3着率）という別のデータソースなので、
 * 独立に検証する。
 *
 * リーク防止：各選手の「隊列内位置別成績」は全期間の集計から、検証対象の
 * そのレース自身の結果を差し引いた値（レース単位でのleave-one-out）を使う。
 */

type Row = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  finish_pos: number;
};

type PosStat = { races: number; wins: number; seconds: number; thirds: number };

function bucketLabel(rate: number, cuts: number[]): string {
  if (rate < cuts[0]) return "低";
  if (rate < cuts[1]) return "中";
  return "高";
}

async function main() {
  const db = getDb();
  const entriesResult = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, e.line_position, r.finish_pos
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE r.finish_pos IS NOT NULL
    ORDER BY e.race_id
  `);
  const rows = entriesResult.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  // ---- 選手×隊列位置のグローバル集計（leave-one-out用のベース） ----
  const globalStats = new Map<string, PosStat>(); // key: snum:position
  for (const r of rows) {
    if (!r.line_position) continue;
    const key = `${r.snum}:${r.line_position}`;
    const s = globalStats.get(key) ?? { races: 0, wins: 0, seconds: 0, thirds: 0 };
    s.races++;
    if (r.finish_pos === 1) s.wins++;
    else if (r.finish_pos === 2) s.seconds++;
    else if (r.finish_pos === 3) s.thirds++;
    globalStats.set(key, s);
  }

  function priorRate(
    snum: string,
    position: string,
    excludeFinishPos: number,
    kind: "win" | "second" | "third"
  ): { rate: number; n: number } | null {
    const s = globalStats.get(`${snum}:${position}`);
    if (!s) return null;
    const races = s.races - 1;
    if (races <= 0) return null;
    let numer = kind === "win" ? s.wins : kind === "second" ? s.seconds : s.thirds;
    if (kind === "win" && excludeFinishPos === 1) numer--;
    if (kind === "second" && excludeFinishPos === 2) numer--;
    if (kind === "third" && excludeFinishPos === 3) numer--;
    return { rate: (numer / races) * 100, n: races };
  }

  // ---- レースごとにライングループを組み立てる ----
  const byRaceLine = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.line_group == null) continue;
    const key = `${r.race_id}:${r.line_group}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(r);
    byRaceLine.set(key, arr);
  }

  const MIN_N = 5; // leave-one-out後の母数がこれ未満は除外

  // ---- 仮説2/3/4: 先頭×番手の力関係 ----
  // 番手が先頭より上位で入線したか（＝差した/逃げ切れなかった）
  const bantesuStats: Record<string, { n: number; bantesuAhead: number }> = {};
  const senkoStats: Record<string, { n: number; bantesuAhead: number }> = {};

  for (const [, members] of byRaceLine) {
    const senko = members.find((m) => m.line_position === "先頭");
    const bantesu = members.find((m) => m.line_position === "番手");
    if (!senko || !bantesu) continue;
    const bantesuAhead = bantesu.finish_pos < senko.finish_pos;

    // 番手選手自身の「番手」時の勝率（高いほど＝差せる番手）
    const bWin = priorRate(bantesu.snum, "番手", bantesu.finish_pos, "win");
    if (bWin && bWin.n >= MIN_N) {
      const bucket = bucketLabel(bWin.rate, [10, 20]);
      const s = bantesuStats[bucket] ?? { n: 0, bantesuAhead: 0 };
      s.n++;
      if (bantesuAhead) s.bantesuAhead++;
      bantesuStats[bucket] = s;
    }

    // 先頭選手自身の「先頭」時の2着率（高いほど＝差されやすい先頭）
    const sSecond = priorRate(senko.snum, "先頭", senko.finish_pos, "second");
    if (sSecond && sSecond.n >= MIN_N) {
      const bucket = bucketLabel(sSecond.rate, [15, 25]);
      const s = senkoStats[bucket] ?? { n: 0, bantesuAhead: 0 };
      s.n++;
      if (bantesuAhead) s.bantesuAhead++;
      senkoStats[bucket] = s;
    }
  }

  console.log("\n■ 仮説2/3: 番手選手の「番手時1着率」バケット別 → 番手が先頭より上位で入線した率");
  for (const bucket of ["低", "中", "高"]) {
    const s = bantesuStats[bucket];
    if (!s) continue;
    console.log(`  ${bucket}: ${((s.bantesuAhead / s.n) * 100).toFixed(1)}% (${s.bantesuAhead}/${s.n})`);
  }

  console.log("\n■ 仮説4: 先頭選手の「先頭時2着率」バケット別 → 番手が先頭より上位で入線した率");
  for (const bucket of ["低", "中", "高"]) {
    const s = senkoStats[bucket];
    if (!s) continue;
    console.log(`  ${bucket}: ${((s.bantesuAhead / s.n) * 100).toFixed(1)}% (${s.bantesuAhead}/${s.n})`);
  }

  // ---- 仮説1: 3番手選手の「3番手時3着率」→ ライン3着内独占率 ----
  const sweepStats: Record<string, { n: number; sweep: number }> = {};
  for (const [, members] of byRaceLine) {
    if (members.length < 3) continue;
    const third = members.find((m) => m.line_position === "3番手");
    if (!third) continue;
    const top3PosSet = new Set([1, 2, 3]);
    const sweep = members.slice(0, 3).every((m) => top3PosSet.has(m.finish_pos));

    const tThird = priorRate(third.snum, "3番手", third.finish_pos, "third");
    if (tThird && tThird.n >= MIN_N) {
      const bucket = bucketLabel(tThird.rate, [8, 15]);
      const s = sweepStats[bucket] ?? { n: 0, sweep: 0 };
      s.n++;
      if (sweep) s.sweep++;
      sweepStats[bucket] = s;
    }
  }

  console.log("\n■ 仮説1: 3番手選手の「3番手時3着率」バケット別 → ライン3人が3着内独占した率");
  for (const bucket of ["低", "中", "高"]) {
    const s = sweepStats[bucket];
    if (!s) continue;
    console.log(`  ${bucket}: ${((s.sweep / s.n) * 100).toFixed(1)}% (${s.sweep}/${s.n})`);
  }
}

main();
