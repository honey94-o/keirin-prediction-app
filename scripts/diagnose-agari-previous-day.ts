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
import { parseEncp } from "../lib/date";

/**
 * ユーザー仮説：2日目以降のレース（予選→準決勝→決勝など同一開催内の複数日）で、
 * 「前日（同一開催内）の上がりタイム」が当日の調子・仕上がりを示す先行指標に
 * ならないか。
 *
 * 注意（交絡）：2日目以降に出走できるのは前日を勝ち上がった選手だけなので、
 * サンプルは既に「前日強かった選手」に選別されている（survivorship bias）。
 * つまり素の相関が出ても「上がりタイムという指標自体が効く」のか「勝ち上がる
 * ような選手はそもそも強い」のかを区別する必要がある → heikin_tokuten三分位で
 * 層別して、地力を揃えても再現するかを見る（diagnose-solo-personal.tsと同じ手法）。
 */

type Row = {
  race_id: number;
  jocd: string;
  encp: string | null;
  kaisai_date: string;
  snum: string;
  finish_pos: number;
  agari_time: number | null;
  heikin_tokuten: number | null;
};

function bucketLabel(rate: number, cuts: number[]): string {
  if (rate < cuts[0]) return "遅";
  if (rate < cuts[1]) return "中";
  return "速";
}

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.race_id, ra.jocd, ra.encp, ra.kaisai_date, e.snum,
           r.finish_pos, r.agari_time, rc.heikin_tokuten
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
      AND ra.encp LIKE 'wt:%'
    ORDER BY ra.kaisai_date
  `);
  const rows = result.rows as unknown as Row[];
  console.log(`WINTICKET由来・結果確定済み出走: ${rows.length}件`);

  // (jocd, cupId, day, snum) -> その日の本人の上がりタイム
  const agariByDay = new Map<string, number>();
  for (const r of rows) {
    const parsed = parseEncp(r.encp);
    if (!parsed || r.agari_time == null) continue;
    agariByDay.set(`${r.jocd}:${parsed.cupId}:${parsed.day}:${r.snum}`, r.agari_time);
  }

  type Sample = {
    prevAgari: number;
    heikin: number | null;
    win: boolean;
    top3: boolean;
    kaisaiDate: string;
  };
  const samples: Sample[] = [];
  let day2plusCount = 0;
  for (const r of rows) {
    const parsed = parseEncp(r.encp);
    if (!parsed || parsed.day < 2) continue;
    day2plusCount++;
    const prevKey = `${r.jocd}:${parsed.cupId}:${parsed.day - 1}:${r.snum}`;
    const prevAgari = agariByDay.get(prevKey);
    if (prevAgari == null) continue; // 前日その開催で出走していない（勝ち上がっていない等）
    samples.push({
      prevAgari,
      heikin: r.heikin_tokuten,
      win: r.finish_pos === 1,
      top3: r.finish_pos <= 3,
      kaisaiDate: r.kaisai_date,
    });
  }
  console.log(`同一開催2日目以降の出走: ${day2plusCount}件`);
  console.log(`うち前日の上がりタイムが取得できたペア: ${samples.length}件\n`);

  if (samples.length < 50) {
    console.log("サンプルが少なすぎるため結果は参考程度（バックフィル進行中の可能性）。");
  }

  function printBuckets(data: Sample[], outcome: "win" | "top3", label: string, cuts: number[]) {
    const buckets = { 遅: [] as Sample[], 中: [] as Sample[], 速: [] as Sample[] };
    for (const d of data) buckets[bucketLabel(d.prevAgari, cuts) as "遅" | "中" | "速"].push(d);
    console.log(`■ ${label}`);
    // 上がりタイムは「速い＝小さい値」。遅/中/速の順に表示するためcutsは秒の閾値。
    for (const b of ["速", "中", "遅"] as const) {
      const arr = buckets[b];
      if (arr.length === 0) continue;
      const hits = arr.filter((d) => d[outcome]).length;
      console.log(`  ${b}: ${((hits / arr.length) * 100).toFixed(1)}% (${hits}/${arr.length})`);
    }
  }

  // 全体のtertile境界を決める
  const sortedAgari = [...samples].sort((a, b) => a.prevAgari - b.prevAgari);
  const tertileSize = Math.floor(sortedAgari.length / 3);
  const cuts = tertileSize > 0
    ? [sortedAgari[tertileSize].prevAgari, sortedAgari[tertileSize * 2].prevAgari]
    : [0, 0];
  console.log(`(前日上がりタイムのtertile境界: 速<${cuts[0].toFixed(1)}秒, 中<${cuts[1].toFixed(1)}秒)\n`);

  printBuckets(samples, "win", "前日上がりタイム(全体) → 当日単勝的中率", cuts);
  console.log();
  printBuckets(samples, "top3", "前日上がりタイム(全体) → 当日複勝的中率", cuts);
  console.log();

  // 地力（heikin_tokuten）三分位で層別（単なる「勝ち上がった選手は強い」の言い換えでないか確認）
  const withHeikin = samples.filter((d) => d.heikin != null) as (Sample & { heikin: number })[];
  const sortedHeikin = [...withHeikin].sort((a, b) => a.heikin - b.heikin);
  const hTertileSize = Math.floor(sortedHeikin.length / 3);
  const tertiles = [
    { label: "地力下位1/3", data: sortedHeikin.slice(0, hTertileSize) },
    { label: "地力中位1/3", data: sortedHeikin.slice(hTertileSize, hTertileSize * 2) },
    { label: "地力上位1/3", data: sortedHeikin.slice(hTertileSize * 2) },
  ];
  for (const t of tertiles) {
    printBuckets(t.data, "win", `[${t.label}] 前日上がりタイム → 当日単勝的中率`, cuts);
  }

  console.log("\n■ ホールドアウト検証（速バケット vs 遅バケットの当日単勝的中率）:");
  const dates = [...new Set(samples.map((d) => d.kaisaiDate))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainData = samples.filter((d) => d.kaisaiDate < splitDate);
  const testData = samples.filter((d) => d.kaisaiDate >= splitDate);
  console.log(`  train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}`);

  function fastSlowRate(data: Sample[]) {
    const fast = data.filter((d) => d.prevAgari < cuts[0]);
    const slow = data.filter((d) => d.prevAgari >= cuts[1]);
    const rate = (arr: Sample[]) =>
      arr.length > 0 ? ((arr.filter((d) => d.win).length / arr.length) * 100).toFixed(1) : "-";
    return `速${rate(fast)}%(n=${fast.length}) / 遅${rate(slow)}%(n=${slow.length})`;
  }
  console.log(`  [train] ${fastSlowRate(trainData)}`);
  console.log(`  [test]  ${fastSlowRate(testData)}`);
}

main();
