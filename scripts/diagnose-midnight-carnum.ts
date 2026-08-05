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

/**
 * ミッドナイト競輪（発走21〜23時台）は車番が得点順に割り当てられるという
 * ユーザー指摘の検証用診断スクリプト。発走時刻帯別に「車番1がそのレースの
 * 得点最高選手と一致する割合」を集計する。
 */
async function main() {
  const db = getDb();

  const dist = await db.execute(`
    SELECT start_time, COUNT(*) as cnt FROM races
    WHERE start_time IS NOT NULL
    GROUP BY start_time
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log("start_time分布(上位20):");
  for (const row of dist.rows as unknown as { start_time: string; cnt: number }[]) {
    console.log(`  ${row.start_time}: ${row.cnt}件`);
  }

  const midnightLike = await db.execute(`
    SELECT DISTINCT syumoku, grade_kbn FROM races
    WHERE syumoku LIKE '%ミッドナイト%' OR grade_kbn LIKE '%ミッドナイト%'
  `);
  console.log("\nミッドナイト表記を含むsyumoku/grade_kbn:", midnightLike.rows);

  const res = await db.execute(`
    SELECT e.race_id, e.car_num, r.heikin_tokuten as tokuten, ra.start_time
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE r.heikin_tokuten IS NOT NULL AND ra.start_time IS NOT NULL
  `);
  type Row = { race_id: number; car_num: number; tokuten: number; start_time: string };
  const rows = res.rows as unknown as Row[];

  const byRace = new Map<number, Row[]>();
  for (const row of rows) {
    const arr = byRace.get(row.race_id) ?? [];
    arr.push(row);
    byRace.set(row.race_id, arr);
  }

  // レースごとに「car_num=1の選手が、そのレースで得点最高だったか」を判定し、
  // 発走時刻帯別に集計する
  const byHourBucket = new Map<string, { total: number; car1IsTop: number }>();
  for (const arr of byRace.values()) {
    if (arr.length < 3) continue;
    const car1 = arr.find((r) => r.car_num === 1);
    if (!car1) continue;
    const maxTokuten = Math.max(...arr.map((r) => r.tokuten));
    const isTop = car1.tokuten === maxTokuten;
    const hour = arr[0].start_time.slice(0, 2);
    const bucket = byHourBucket.get(hour) ?? { total: 0, car1IsTop: 0 };
    bucket.total++;
    if (isTop) bucket.car1IsTop++;
    byHourBucket.set(hour, bucket);
  }
  console.log("\n発走時刻(時)別: 車番1が得点最高だった割合:");
  for (const [hour, b] of [...byHourBucket.entries()].sort()) {
    console.log(`  ${hour}時台: ${b.total}レース中${b.car1IsTop}件が車番1=得点最高 (${((b.car1IsTop / b.total) * 100).toFixed(1)}%)`);
  }
}

main();
