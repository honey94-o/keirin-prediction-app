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
 * 新規候補3件の一括検証（いずれも新規スクレイピング不要、既存データのみ）:
 *   1. ギア倍数（重い/軽い）と脚質・バンク周長の相性
 *   2. ラインの人数構成（単騎/2人/3人/4人以上）別のワンツー率・先頭勝率
 *   3. 先頭×番手の脚質の組み合わせ別の先頭勝率・ワンツー率
 */

async function main() {
  const db = getDb();

  const entriesResult = await db.execute(`
    SELECT e.race_id, ra.jocd, ra.kaisai_date, ra.kyori, ra.shukai,
           e.snum, e.car_num, e.line_group, e.line_position,
           r.finish_pos, rc.gear_ratio, rc.kyakushitsu
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date, e.race_id
  `);
  type Row = {
    race_id: number;
    jocd: string;
    kaisai_date: string;
    kyori: number | null;
    shukai: number | null;
    snum: string;
    car_num: number;
    line_group: number | null;
    line_position: string | null;
    finish_pos: number;
    gear_ratio: number | null;
    kyakushitsu: string | null;
  };
  const entries = entriesResult.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${entries.length}件\n`);

  // ============ 1. ギア倍数 ============
  const withGear = entries.filter((e) => e.gear_ratio != null && e.kyori != null && e.shukai != null);
  console.log(`■ 1. ギア倍数（データあり${withGear.length}件）`);
  if (withGear.length === 0) {
    console.log("  gear_ratioは現在のスクレイパーでは未取得のためスキップ（要スクレイパー対応）");
  } else {
    const gearValues = withGear.map((e) => e.gear_ratio!).sort((a, b) => a - b);
    const median = gearValues[Math.floor(gearValues.length / 2)];
    console.log(`  中央値: ${median.toFixed(2)}`);
    // (以下省略、データがあれば実行される)
  }

  // ============ 2. ラインの人数構成 ============
  console.log(`\n■ 2. ラインの人数構成:`);
  const byRaceLine = new Map<string, Row[]>();
  for (const e of entries) {
    const key = e.line_group != null ? `${e.race_id}:${e.line_group}` : `${e.race_id}:solo:${e.car_num}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(e);
    byRaceLine.set(key, arr);
  }
  const sizeBuckets = new Map<number, { lines: number; wantsu: number; senkoWin: number }>();
  for (const [, members] of byRaceLine) {
    const size = Math.min(members.length, 4); // 4人以上はまとめる
    const b = sizeBuckets.get(size) ?? { lines: 0, wantsu: 0, senkoWin: 0 };
    b.lines++;
    const isWantsu = members.some((m) => m.finish_pos === 1) && members.some((m) => m.finish_pos === 2);
    if (isWantsu) b.wantsu++;
    const senko = members.find((m) => m.line_position === "先頭") ?? members[0];
    if (senko.finish_pos === 1) b.senkoWin++;
    sizeBuckets.set(size, b);
  }
  for (const [size, b] of [...sizeBuckets.entries()].sort()) {
    const label = size === 1 ? "単騎" : size >= 4 ? "4人以上" : `${size}人`;
    console.log(
      `  ${label}: ${b.lines}本 ワンツー率${((b.wantsu / b.lines) * 100).toFixed(1)}% 先頭勝率${((b.senkoWin / b.lines) * 100).toFixed(1)}%`
    );
  }

  // ============ 3. 先頭×番手の脚質ペア相性 ============
  console.log(`\n■ 3. 先頭×番手の脚質ペア相性（先頭の勝率・ワンツー率）:`);
  const pairBuckets = new Map<string, { lines: number; senkoWin: number; wantsu: number }>();
  for (const [, members] of byRaceLine) {
    if (members.length < 2) continue;
    const senko = members.find((m) => m.line_position === "先頭");
    const bantesu = members.find((m) => m.line_position === "番手");
    if (!senko || !bantesu || !senko.kyakushitsu || !bantesu.kyakushitsu) continue;
    const key = `${senko.kyakushitsu}先頭×${bantesu.kyakushitsu}番手`;
    const b = pairBuckets.get(key) ?? { lines: 0, senkoWin: 0, wantsu: 0 };
    b.lines++;
    if (senko.finish_pos === 1) b.senkoWin++;
    const isWantsu = members.some((m) => m.finish_pos === 1) && members.some((m) => m.finish_pos === 2);
    if (isWantsu) b.wantsu++;
    pairBuckets.set(key, b);
  }
  for (const [key, b] of [...pairBuckets.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(
      `  ${key}: ${b.lines}本 先頭勝率${((b.senkoWin / b.lines) * 100).toFixed(1)}% ワンツー率${((b.wantsu / b.lines) * 100).toFixed(1)}%`
    );
  }
}

main();
