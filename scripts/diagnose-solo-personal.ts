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
 * ユーザー仮説：単騎（自分のラインが自分だけ）が得意な選手・苦手な選手がいて、
 * 単騎で走った時の個人的な勝率・3着内率で加点/減点できないか。
 * 既存のcalculatePositionWinRateScoreはline_position（先頭/番手/3番手）別だが、
 * 単騎の「先頭」と複数人ラインの「先頭」を区別していない（単騎はWINTICKET上
 * line_positionが常に"先頭"表記のため）。つまりこの信号はまだ一度も使っていない。
 *
 * leave-one-out（そのレース自身の結果を除いた個人集計）で検証する。
 */

type Row = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  finish_pos: number;
  heikin_tokuten: number | null;
  kaisai_date: string;
};

function bucketLabel(rate: number, cuts: number[]): string {
  if (rate < cuts[0]) return "低";
  if (rate < cuts[1]) return "中";
  return "高";
}

async function main() {
  const db = getDb();
  const entriesResult = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, r.finish_pos, rc.heikin_tokuten,
           ra.kaisai_date
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date
  `);
  const rows = entriesResult.rows as unknown as (Row & { kaisai_date: string })[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  // レースごとにline_groupの人数を数え、単騎（人数1）を判定する
  const lineSizeByRaceLine = new Map<string, number>();
  for (const r of rows) {
    if (r.line_group == null) continue;
    const key = `${r.race_id}:${r.line_group}`;
    lineSizeByRaceLine.set(key, (lineSizeByRaceLine.get(key) ?? 0) + 1);
  }
  function isSolo(r: Row): boolean {
    if (r.line_group == null) return false;
    return lineSizeByRaceLine.get(`${r.race_id}:${r.line_group}`) === 1;
  }

  const soloRows = rows.filter(isSolo);
  console.log(`うち単騎の出走: ${soloRows.length}件（${((soloRows.length / rows.length) * 100).toFixed(1)}%）\n`);

  // 選手ごとの単騎時グローバル集計（leave-one-out用）
  type Stat = { races: number; wins: number; top3: number };
  const globalSoloStats = new Map<string, Stat>();
  for (const r of soloRows) {
    const s = globalSoloStats.get(r.snum) ?? { races: 0, wins: 0, top3: 0 };
    s.races++;
    if (r.finish_pos === 1) s.wins++;
    if (r.finish_pos <= 3) s.top3++;
    globalSoloStats.set(r.snum, s);
  }

  function priorSoloRate(
    snum: string,
    excludeFinishPos: number,
    kind: "win" | "top3"
  ): { rate: number; n: number } | null {
    const s = globalSoloStats.get(snum);
    if (!s) return null;
    const races = s.races - 1;
    if (races <= 0) return null;
    let numer = kind === "win" ? s.wins : s.top3;
    if (kind === "win" && excludeFinishPos === 1) numer--;
    if (kind === "top3" && excludeFinishPos <= 3) numer--;
    return { rate: (numer / races) * 100, n: races };
  }

  const MIN_N = 5;
  type Bucketed = {
    winRate: number;
    top3Rate: number;
    heikin: number | null;
    win: boolean;
    top3: boolean;
    kaisaiDate: string;
  };
  const winBucketed: Bucketed[] = [];

  for (const r of soloRows) {
    const w = priorSoloRate(r.snum, r.finish_pos, "win");
    const t = priorSoloRate(r.snum, r.finish_pos, "top3");
    if (w && w.n >= MIN_N) {
      winBucketed.push({
        winRate: w.rate,
        top3Rate: t?.rate ?? 0,
        heikin: r.heikin_tokuten,
        win: r.finish_pos === 1,
        top3: r.finish_pos <= 3,
        kaisaiDate: r.kaisai_date,
      });
    }
  }

  function printBuckets(data: Bucketed[], key: "winRate" | "top3Rate", outcome: "win" | "top3", label: string, cuts: number[]) {
    const buckets = { 低: [] as Bucketed[], 中: [] as Bucketed[], 高: [] as Bucketed[] };
    for (const d of data) buckets[bucketLabel(d[key], cuts) as "低" | "中" | "高"].push(d);
    console.log(`■ ${label}`);
    for (const b of ["低", "中", "高"] as const) {
      const arr = buckets[b];
      if (arr.length === 0) continue;
      const hits = arr.filter((d) => d[outcome]).length;
      console.log(`  ${b}: ${((hits / arr.length) * 100).toFixed(1)}% (${hits}/${arr.length})`);
    }
  }

  printBuckets(winBucketed, "winRate", "win", "単騎時個人勝率バケット別 → 実際の単騎勝率", [8, 16]);
  console.log();

  // 地力（heikin_tokuten）三分位で層別（単なる強さの言い換えでないか確認）
  const withHeikin = winBucketed.filter((d) => d.heikin != null) as (Bucketed & { heikin: number })[];
  const sorted = [...withHeikin].sort((a, b) => a.heikin - b.heikin);
  const tertileSize = Math.floor(sorted.length / 3);
  const tertiles = [
    { label: "地力下位1/3", data: sorted.slice(0, tertileSize) },
    { label: "地力中位1/3", data: sorted.slice(tertileSize, tertileSize * 2) },
    { label: "地力上位1/3", data: sorted.slice(tertileSize * 2) },
  ];
  for (const t of tertiles) {
    printBuckets(t.data, "winRate", "win", `[${t.label}] 単騎時個人勝率バケット別 → 実際の単騎勝率`, [8, 16]);
  }

  // ---- ホールドアウト検証：低バケット vs 高バケットの勝率差がtrain/testで再現するか ----
  console.log("\n■ ホールドアウト検証（低バケット vs 高バケットの実際の単騎勝率）:");
  const dates = [...new Set(winBucketed.map((d) => d.kaisaiDate))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainData = winBucketed.filter((d) => d.kaisaiDate < splitDate);
  const testData = winBucketed.filter((d) => d.kaisaiDate >= splitDate);
  console.log(`  train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}`);

  function lowHighRate(data: Bucketed[], cuts: number[]) {
    const low = data.filter((d) => d.winRate < cuts[0]);
    const high = data.filter((d) => d.winRate >= cuts[1]);
    const rate = (arr: Bucketed[]) =>
      arr.length > 0 ? ((arr.filter((d) => d.win).length / arr.length) * 100).toFixed(1) : "-";
    return `低${rate(low)}%(n=${low.length}) / 高${rate(high)}%(n=${high.length})`;
  }
  console.log(`  [train] ${lowHighRate(trainData, [8, 16])}`);
  console.log(`  [test]  ${lowHighRate(testData, [8, 16])}`);
}

main();
