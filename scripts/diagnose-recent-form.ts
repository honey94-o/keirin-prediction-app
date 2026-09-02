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
import { getRacerHistory, enableReadCache } from "../lib/repository";

/**
 * 「直近成績（好調・不調の波）」が勝率に効くか診断する。
 * 既存のcalculateSameConditionScore（同開催場限定）・calculateIntervalScore
 * （出走間隔）はracer_race_historyを使っているが、venue問わず直近何走かの
 * 平均着順そのもの（近況の調子）はまだスコアに使っていない。
 *
 * race_dateは年無しMM/DDのため厳密な前後判定はできない（既存のcalculateIntervalScore
 * と同じ簡易近似：年をまたいだ場合365日分でラップして最小差を採用）。この近似は
 * このテーブルを使う既存機能と同じ精度なので新規のリスクではない。
 */

const MONTH_DAY_RE = /^(\d{2})\/(\d{2})$/;
function monthDayToDayOfYear(md: string): number | null {
  const m = MONTH_DAY_RE.exec(md);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  if (month < 1 || month > 12) return null;
  return cumulative[month - 1] + day;
}

const RECENT_EVENTS = 3; // 直近何"イベント"（開催、1イベント=2〜4走ぶんのfinish_positions）を見るか

function computeRecentFormAvg(kaisaiDate: string, history: { race_date: string; finish_positions: string }[]): number | null {
  const raceMonth = Number(kaisaiDate.slice(4, 6));
  const raceDay = Number(kaisaiDate.slice(6, 8));
  const raceDoy = monthDayToDayOfYear(`${String(raceMonth).padStart(2, "0")}/${String(raceDay).padStart(2, "0")}`);
  if (raceDoy == null) return null;

  const withDiff = history
    .map((h) => {
      const doy = monthDayToDayOfYear(h.race_date);
      if (doy == null) return null;
      let diff = raceDoy - doy;
      if (diff <= 0) diff += 365; // 年跨ぎの近似（当日自身は除外するため<=0も繰り下げ）
      return { diff, h };
    })
    .filter((x): x is { diff: number; h: typeof history[number] } => x != null)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, RECENT_EVENTS);

  const positions: number[] = [];
  for (const { h } of withDiff) {
    for (const p of h.finish_positions.split(",")) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) positions.push(n);
    }
  }
  if (positions.length === 0) return null;
  return positions.reduce((a, b) => a + b, 0) / positions.length;
}

async function main() {
  enableReadCache();
  const db = getDb();

  const entriesResult = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, ra.kaisai_date, r.finish_pos,
           rc.heikin_tokuten
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN races ra ON ra.id = e.race_id
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date
  `);
  type Row = {
    race_id: number;
    snum: string;
    car_num: number;
    kaisai_date: string;
    finish_pos: number;
    heikin_tokuten: number | null;
  };
  const rows = entriesResult.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  const snums = [...new Set(rows.map((r) => r.snum))];
  console.log(`対象選手数: ${snums.length}人`);

  const historyBySnum = new Map<string, { race_date: string; finish_positions: string }[]>();
  let done = 0;
  for (const snum of snums) {
    const h = await getRacerHistory(snum);
    historyBySnum.set(snum, h);
    done++;
    if (done % 500 === 0) console.log(`  履歴取得 ${done}/${snums.length}`);
  }

  type Bucketed = { formAvg: number; heikin: number | null; win: boolean; top3: boolean };
  const bucketed: Bucketed[] = [];
  let skippedNoHistory = 0;
  for (const r of rows) {
    const history = historyBySnum.get(r.snum) ?? [];
    const formAvg = computeRecentFormAvg(r.kaisai_date, history);
    if (formAvg == null) {
      skippedNoHistory++;
      continue;
    }
    bucketed.push({
      formAvg,
      heikin: r.heikin_tokuten,
      win: r.finish_pos === 1,
      top3: r.finish_pos <= 3,
    });
  }
  console.log(`直近成績を計算できた出走: ${bucketed.length}件（履歴なしでスキップ: ${skippedNoHistory}件）\n`);

  // ---- 単純バケット分析（全体） ----
  function printBuckets(data: Bucketed[], label: string) {
    const sorted = [...data].sort((a, b) => a.formAvg - b.formAvg);
    const bucketCount = 5;
    const size = Math.floor(sorted.length / bucketCount);
    console.log(`■ ${label}（n=${data.length}）`);
    for (let i = 0; i < bucketCount; i++) {
      const slice = i === bucketCount - 1 ? sorted.slice(i * size) : sorted.slice(i * size, (i + 1) * size);
      if (slice.length === 0) continue;
      const wins = slice.filter((s) => s.win).length;
      const top3s = slice.filter((s) => s.top3).length;
      const avgForm = slice.reduce((a, b) => a + b.formAvg, 0) / slice.length;
      console.log(
        `  直近平均着順${avgForm.toFixed(2)}台(${i + 1}/${bucketCount}分位): ` +
          `勝率${((wins / slice.length) * 100).toFixed(1)}% (${wins}/${slice.length}) / ` +
          `複勝率${((top3s / slice.length) * 100).toFixed(1)}%`
      );
    }
    console.log();
  }

  printBuckets(bucketed, "全体：直近成績バケット別 勝率");

  // ---- heikin_tokuten三分位で層別（既存の強さ指標との重複チェック） ----
  const withHeikin = bucketed.filter((b) => b.heikin != null) as (Bucketed & { heikin: number })[];
  const sortedByHeikin = [...withHeikin].sort((a, b) => a.heikin - b.heikin);
  const tertileSize = Math.floor(sortedByHeikin.length / 3);
  const tertiles = [
    { label: "得点下位1/3", data: sortedByHeikin.slice(0, tertileSize) },
    { label: "得点中位1/3", data: sortedByHeikin.slice(tertileSize, tertileSize * 2) },
    { label: "得点上位1/3", data: sortedByHeikin.slice(tertileSize * 2) },
  ];
  console.log("■ heikin_tokuten三分位ごとに層別（直近成績の効果が得点と重複していないか確認）");
  for (const t of tertiles) {
    printBuckets(t.data, `  [${t.label}] 直近成績バケット別`);
  }
}

main();
