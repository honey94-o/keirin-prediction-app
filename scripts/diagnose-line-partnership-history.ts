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
 * ユーザー仮説：過去に同じ選手同士がライン（隊列）を組んだことがあるか、
 * その時の成績はどうだったかを予想に使えないか（「息の合ったライン」効果）。
 * line_groupはレースごとに振り直される番号（1,2,3...）で選手個人に紐づく
 * 永続IDではないため、「このラインを組んだことがある」の判定は
 * レースをまたいで「同じline_group内に同じsnumのペアが居たか」で行う。
 *
 * beforeDate相当の粒度（kaisai_date昇順で日付バッチ処理、当日は使わない）で
 * 「初めて組むライン」と「過去に一度でも組んだことのあるペアを含むライン」を
 * 分け、先頭選手の勝率・そのラインのワンツー率を比較する。
 * heikin_tokuten三分位で層別し、「単に強い選手同士が呼ばれて固定ラインを
 * 組みがち」という交絡でないか確認する（diagnose-solo-personal.tsと同じ手法）。
 */

type Row = {
  race_id: number;
  kaisai_date: string;
  snum: string;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  finish_pos: number;
  heikin_tokuten: number | null;
};

const MIN_LINE_SIZE = 2;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function combinations2(arr: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  return out;
}

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.race_id, ra.kaisai_date, e.snum, e.car_num, e.line_group, e.line_position,
           r.finish_pos, rc.heikin_tokuten
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date, ra.id
  `);
  const rows = result.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  // race_id -> line_group -> そのラインの出走一覧
  const raceLines = new Map<number, Map<number, Row[]>>();
  // race_id -> 全出走（ワンツー判定に全体の着順が要るため）
  const raceAll = new Map<number, Row[]>();
  for (const r of rows) {
    if (!raceAll.has(r.race_id)) raceAll.set(r.race_id, []);
    raceAll.get(r.race_id)!.push(r);
    if (r.line_group == null) continue;
    if (!raceLines.has(r.race_id)) raceLines.set(r.race_id, new Map());
    const lg = raceLines.get(r.race_id)!;
    if (!lg.has(r.line_group)) lg.set(r.line_group, []);
    lg.get(r.line_group)!.push(r);
  }

  // 日付ごとにバッチ処理（同日は互いの履歴に使わない、本体の日付カットオフと同じ粒度）
  const dateToRaceIds = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!dateToRaceIds.has(r.kaisai_date)) dateToRaceIds.set(r.kaisai_date, new Set());
    dateToRaceIds.get(r.kaisai_date)!.add(r.race_id);
  }
  const sortedDates = [...dateToRaceIds.keys()].sort();

  const pairHistoryCount = new Map<string, number>(); // pairKey -> 過去に同じラインを組んだ回数

  type Sample = {
    hasEstablishedPair: boolean;
    establishedPairCount: number;
    totalPairCount: number;
    lineSize: number;
    senkoHeikin: number | null;
    senkoWin: boolean;
    lineWantsu: boolean; // このラインの2人が1-2着独占
    kaisaiDate: string;
  };
  const samples: Sample[] = [];

  for (const date of sortedDates) {
    const raceIds = dateToRaceIds.get(date)!;
    // まず今日ぶんを、更新前のpairHistoryCountを使って判定する
    for (const raceId of raceIds) {
      const lines = raceLines.get(raceId);
      const allEntries = raceAll.get(raceId)!;
      if (!lines) continue;
      for (const [, lineRows] of lines) {
        if (lineRows.length < MIN_LINE_SIZE) continue;
        const snums = lineRows.map((r) => r.snum);
        const pairs = combinations2(snums);
        const establishedPairs = pairs.filter((p) => (pairHistoryCount.get(pairKey(p[0], p[1])) ?? 0) >= 1);
        const senko = lineRows.find((r) => r.line_position === "先頭") ?? lineRows[0];
        const top2CarNums = allEntries
          .filter((r) => r.finish_pos === 1 || r.finish_pos === 2)
          .map((r) => r.car_num);
        const lineCarNums = new Set(lineRows.map((r) => r.car_num));
        const lineWantsu = top2CarNums.length === 2 && top2CarNums.every((c) => lineCarNums.has(c));
        samples.push({
          hasEstablishedPair: establishedPairs.length > 0,
          establishedPairCount: establishedPairs.length,
          totalPairCount: pairs.length,
          lineSize: lineRows.length,
          senkoHeikin: senko.heikin_tokuten,
          senkoWin: senko.finish_pos === 1,
          lineWantsu,
          kaisaiDate: date,
        });
      }
    }
    // 今日ぶんを反映してから次の日へ
    for (const raceId of raceIds) {
      const lines = raceLines.get(raceId);
      if (!lines) continue;
      for (const [, lineRows] of lines) {
        if (lineRows.length < MIN_LINE_SIZE) continue;
        const snums = lineRows.map((r) => r.snum);
        for (const [a, b] of combinations2(snums)) {
          const key = pairKey(a, b);
          pairHistoryCount.set(key, (pairHistoryCount.get(key) ?? 0) + 1);
        }
      }
    }
  }

  console.log(`判定対象ライン（2人以上）: ${samples.length}件`);
  const withEstablished = samples.filter((s) => s.hasEstablishedPair).length;
  console.log(`うち既存ペアを含むライン: ${withEstablished}件（${((withEstablished / samples.length) * 100).toFixed(1)}%）\n`);

  function printRate(data: Sample[], outcome: "senkoWin" | "lineWantsu", label: string) {
    const withPair = data.filter((s) => s.hasEstablishedPair);
    const without = data.filter((s) => !s.hasEstablishedPair);
    const rate = (arr: Sample[]) =>
      arr.length > 0 ? ((arr.filter((d) => d[outcome]).length / arr.length) * 100).toFixed(1) : "-";
    console.log(`■ ${label}`);
    console.log(`  既存ペアあり: ${rate(withPair)}% (n=${withPair.length})`);
    console.log(`  初顔合わせ  : ${rate(without)}% (n=${without.length})`);
  }

  printRate(samples, "senkoWin", "先頭選手の単勝的中率");
  console.log();
  printRate(samples, "lineWantsu", "そのラインのワンツー率");
  console.log();

  // ライン人数別（2人ラインと3人ラインで力学が違う可能性）
  for (const size of [2, 3]) {
    const sizeData = samples.filter((s) => s.lineSize === size);
    if (sizeData.length === 0) continue;
    printRate(sizeData, "senkoWin", `[${size}人ライン] 先頭選手の単勝的中率`);
    printRate(sizeData, "lineWantsu", `[${size}人ライン] ラインのワンツー率`);
    console.log();
  }

  // 先頭選手のheikin_tokuten三分位で層別（強い選手同士が固定ラインを組みがちという交絡の確認）
  const withHeikin = samples.filter((s) => s.senkoHeikin != null) as (Sample & { senkoHeikin: number })[];
  const sorted = [...withHeikin].sort((a, b) => a.senkoHeikin - b.senkoHeikin);
  const tertileSize = Math.floor(sorted.length / 3);
  const tertiles = [
    { label: "先頭の地力下位1/3", data: sorted.slice(0, tertileSize) },
    { label: "先頭の地力中位1/3", data: sorted.slice(tertileSize, tertileSize * 2) },
    { label: "先頭の地力上位1/3", data: sorted.slice(tertileSize * 2) },
  ];
  for (const t of tertiles) {
    printRate(t.data, "senkoWin", `[${t.label}] 先頭選手の単勝的中率`);
    printRate(t.data, "lineWantsu", `[${t.label}] ラインのワンツー率`);
    console.log();
  }

  console.log("■ ホールドアウト検証（既存ペアあり vs 初顔合わせ、先頭選手の単勝的中率）:");
  const dates = [...new Set(samples.map((d) => d.kaisaiDate))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainData = samples.filter((d) => d.kaisaiDate < splitDate);
  const testData = samples.filter((d) => d.kaisaiDate >= splitDate);
  console.log(`  train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}`);
  function rate(arr: Sample[]) {
    return arr.length > 0
      ? `${((arr.filter((d) => d.senkoWin).length / arr.length) * 100).toFixed(1)}%(n=${arr.length})`
      : "-";
  }
  console.log(`  [train] 既存ペア${rate(trainData.filter((d) => d.hasEstablishedPair))} / 初顔合わせ${rate(trainData.filter((d) => !d.hasEstablishedPair))}`);
  console.log(`  [test]  既存ペア${rate(testData.filter((d) => d.hasEstablishedPair))} / 初顔合わせ${rate(testData.filter((d) => !d.hasEstablishedPair))}`);

  console.log("\n■ ホールドアウト検証（既存ペアあり vs 初顔合わせ、ラインのワンツー率）:");
  function wantsuRate(arr: Sample[]) {
    return arr.length > 0
      ? `${((arr.filter((d) => d.lineWantsu).length / arr.length) * 100).toFixed(1)}%(n=${arr.length})`
      : "-";
  }
  console.log(`  [train] 既存ペア${wantsuRate(trainData.filter((d) => d.hasEstablishedPair))} / 初顔合わせ${wantsuRate(trainData.filter((d) => !d.hasEstablishedPair))}`);
  console.log(`  [test]  既存ペア${wantsuRate(testData.filter((d) => d.hasEstablishedPair))} / 初顔合わせ${wantsuRate(testData.filter((d) => !d.hasEstablishedPair))}`);
}

main();
