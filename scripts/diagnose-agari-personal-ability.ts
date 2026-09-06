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
 * 前日上がりタイム（diagnose-agari-previous-day.ts）は不採用だったが、上がりタイムの
 * 別の使い方：各選手の「レース内での相対的な上がりの速さ」を積み上げた個人の地力
 * 指標として使えないかを検証する。heikin_tokuten（既存の得点ベースのランキング）
 * とは取得元・更新頻度が異なる独立した実測データなので、冗長でない可能性がある。
 *
 * ユーザー仮説（追加）：ガールズケイリンはライン（隊列）が無く、既存の
 * ライン依存シグナル（line_position、番手格差等）が丸ごと使えない
 * （isGirlsRace()時はcalculateLineScoreが自然に中立、generateGirlsScenariosは
 * 純スコアのみで2パターン）。上がりタイムはラインと無関係の個人実測値なので、
 * 通常レースより「代わりに効く」信号になる可能性がある → ガールズ/男子で分けて集計する。
 *
 * 手法：
 * 1. 各レース内で、agari_timeが取れている出走同士だけを比較して相対順位
 *    （agariRankPct、0〜1、1が最速）を出す（バンク周長・距離が違うレース間で
 *    生の秒数を直接比べるノイズを避けるため）。
 * 2. 本体の日付カットオフ修正（lib/repository.tsのbeforeDate）と同じ粒度
 *    （kaisai_date < 対象日、同日は含めない）で、選手ごとの過去の
 *    agariRankPct平均を「その時点までにわかっていた値」として積み上げる。
 * 3. 全体・heikin_tokuten三分位層別・ガールズ/男子別・train/testホールドアウトで
 *    実際の勝率と比較する（diagnose-solo-personal.tsと同じ検証パターン）。
 */

type Row = {
  race_id: number;
  kaisai_date: string;
  snum: string;
  agari_time: number | null;
  finish_pos: number;
  heikin_tokuten: number | null;
  is_girls: boolean;
};

const MIN_N = 5;

function bucketLabel(rate: number, cuts: number[]): string {
  if (rate < cuts[0]) return "低";
  if (rate < cuts[1]) return "中";
  return "高";
}

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.race_id, ra.kaisai_date, e.snum, r.agari_time, r.finish_pos, rc.heikin_tokuten,
           EXISTS (
             SELECT 1 FROM entries e2 JOIN racers rc2 ON rc2.snum = e2.snum
             WHERE e2.race_id = e.race_id AND rc2.class_rank LIKE 'L%'
           ) AS is_girls
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date, ra.id
  `);
  const rows = result.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  // レースごとにagari_timeの相対順位(agariRankPct)を計算
  const byRace = new Map<number, Row[]>();
  for (const r of rows) {
    if (!byRace.has(r.race_id)) byRace.set(r.race_id, []);
    byRace.get(r.race_id)!.push(r);
  }
  const agariRankPct = new Map<string, number>(); // `${race_id}:${snum}` -> 0..1（1が最速）
  let racesWithAgari = 0;
  for (const [raceId, entries] of byRace) {
    const withAgari = entries.filter((e) => e.agari_time != null);
    if (withAgari.length < 2) continue;
    racesWithAgari++;
    for (const e of withAgari) {
      const slowerCount = withAgari.filter((o) => o.agari_time! > e.agari_time!).length;
      agariRankPct.set(`${raceId}:${e.snum}`, slowerCount / (withAgari.length - 1));
    }
  }
  console.log(`agari_timeが2件以上取れたレース: ${racesWithAgari}件\n`);

  // 日付ごとにバッチ処理し、「その日より前」の実績だけを使う（本体の日付カットオフと同じ粒度）
  const dateGroups = new Map<string, Row[]>();
  for (const r of rows) {
    if (!dateGroups.has(r.kaisai_date)) dateGroups.set(r.kaisai_date, []);
    dateGroups.get(r.kaisai_date)!.push(r);
  }
  const sortedDates = [...dateGroups.keys()].sort();

  const history = new Map<string, number[]>(); // snum -> 過去のagariRankPct列
  type Sample = {
    priorAvg: number;
    n: number;
    heikin: number | null;
    isGirls: boolean;
    win: boolean;
    top3: boolean;
    kaisaiDate: string;
  };
  const samples: Sample[] = [];

  for (const date of sortedDates) {
    const dayRows = dateGroups.get(date)!;
    for (const r of dayRows) {
      const past = history.get(r.snum);
      if (past && past.length >= MIN_N) {
        const priorAvg = past.reduce((a, b) => a + b, 0) / past.length;
        samples.push({
          priorAvg,
          n: past.length,
          heikin: r.heikin_tokuten,
          isGirls: r.is_girls,
          win: r.finish_pos === 1,
          top3: r.finish_pos <= 3,
          kaisaiDate: r.kaisai_date,
        });
      }
    }
    // その日ぶんを反映してから次の日へ（同日は互いの履歴に使わない）
    for (const r of dayRows) {
      const pct = agariRankPct.get(`${r.race_id}:${r.snum}`);
      if (pct == null) continue;
      if (!history.has(r.snum)) history.set(r.snum, []);
      history.get(r.snum)!.push(pct);
    }
  }

  console.log(`過去${MIN_N}件以上のagari実績を持つ出走（判定対象）: ${samples.length}件\n`);

  function printBuckets(data: Sample[], outcome: "win" | "top3", label: string, cuts: number[]) {
    const buckets = { 低: [] as Sample[], 中: [] as Sample[], 高: [] as Sample[] };
    for (const d of data) buckets[bucketLabel(d.priorAvg, cuts) as "低" | "中" | "高"].push(d);
    console.log(`■ ${label}`);
    for (const b of ["低", "中", "高"] as const) {
      const arr = buckets[b];
      if (arr.length === 0) continue;
      const hits = arr.filter((d) => d[outcome]).length;
      console.log(`  ${b}: ${((hits / arr.length) * 100).toFixed(1)}% (${hits}/${arr.length})`);
    }
  }

  const CUTS = [0.4, 0.6]; // agariRankPctは0..1、0.5が「平均的な速さ」の目安

  printBuckets(samples, "win", "過去の相対上がり平均(全体) → 単勝的中率", CUTS);
  console.log();
  printBuckets(samples, "top3", "過去の相対上がり平均(全体) → 複勝的中率", CUTS);
  console.log();

  const withHeikin = samples.filter((d) => d.heikin != null) as (Sample & { heikin: number })[];
  const sorted = [...withHeikin].sort((a, b) => a.heikin - b.heikin);
  const tertileSize = Math.floor(sorted.length / 3);
  const tertiles = [
    { label: "地力下位1/3", data: sorted.slice(0, tertileSize) },
    { label: "地力中位1/3", data: sorted.slice(tertileSize, tertileSize * 2) },
    { label: "地力上位1/3", data: sorted.slice(tertileSize * 2) },
  ];
  for (const t of tertiles) {
    printBuckets(t.data, "win", `[${t.label}] 過去の相対上がり平均 → 単勝的中率`, CUTS);
  }
  console.log();

  const girlsSamples = samples.filter((d) => d.isGirls);
  const menSamples = samples.filter((d) => !d.isGirls);
  console.log(`--- ガールズ vs 男子で分割（ガールズ: ${girlsSamples.length}件 / 男子: ${menSamples.length}件） ---`);
  printBuckets(girlsSamples, "win", "[ガールズのみ] 過去の相対上がり平均 → 単勝的中率", CUTS);
  console.log();
  printBuckets(menSamples, "win", "[男子のみ] 過去の相対上がり平均 → 単勝的中率", CUTS);
  console.log();

  // ガールズだけでheikin_tokuten三分位層別（既存ランキング点の言い換えでないか確認）
  const girlsWithHeikin = girlsSamples.filter((d) => d.heikin != null) as (Sample & { heikin: number })[];
  const sortedGirlsHeikin = [...girlsWithHeikin].sort((a, b) => a.heikin - b.heikin);
  const gTertileSize = Math.floor(sortedGirlsHeikin.length / 3);
  const girlsTertiles = [
    { label: "[ガールズ]地力下位1/3", data: sortedGirlsHeikin.slice(0, gTertileSize) },
    { label: "[ガールズ]地力中位1/3", data: sortedGirlsHeikin.slice(gTertileSize, gTertileSize * 2) },
    { label: "[ガールズ]地力上位1/3", data: sortedGirlsHeikin.slice(gTertileSize * 2) },
  ];
  for (const t of girlsTertiles) {
    printBuckets(t.data, "win", `${t.label} 過去の相対上がり平均 → 単勝的中率`, CUTS);
  }
  console.log();

  console.log("■ ホールドアウト検証（低バケット vs 高バケットの単勝的中率、全体）:");
  const dates = [...new Set(samples.map((d) => d.kaisaiDate))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainData = samples.filter((d) => d.kaisaiDate < splitDate);
  const testData = samples.filter((d) => d.kaisaiDate >= splitDate);
  console.log(`  train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}`);

  function lowHighRate(data: Sample[]) {
    const low = data.filter((d) => d.priorAvg < CUTS[0]);
    const high = data.filter((d) => d.priorAvg >= CUTS[1]);
    const rate = (arr: Sample[]) =>
      arr.length > 0 ? ((arr.filter((d) => d.win).length / arr.length) * 100).toFixed(1) : "-";
    return `低${rate(low)}%(n=${low.length}) / 高${rate(high)}%(n=${high.length})`;
  }
  console.log(`  [train] ${lowHighRate(trainData)}`);
  console.log(`  [test]  ${lowHighRate(testData)}`);

  console.log("\n■ ホールドアウト検証（ガールズのみ）:");
  const girlsTrain = girlsSamples.filter((d) => d.kaisaiDate < splitDate);
  const girlsTest = girlsSamples.filter((d) => d.kaisaiDate >= splitDate);
  console.log(`  [train] ${lowHighRate(girlsTrain)}`);
  console.log(`  [test]  ${lowHighRate(girlsTest)}`);
}

main();
