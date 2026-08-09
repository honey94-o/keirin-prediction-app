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
 * diagnose-wind-kimarite.tsの決まり手ベースの検証は効果量が小さかった（逃 24.3%→26.3%、
 * 差 44.7%→42.6%、風速0-2m/sと4m/s+の比較で、信頼区間が重なる程度）。
 * より直接的な仮説「強風で番手・3番手のライダーは風除けを使いにくく不利になる
 * （＝追込型が不利、逃げ型が有利）」を、選手個人の脚質（racers.kyakushitsu）×
 * 風速帯×ライン位置で見て、決まり手ベースより強い signal が出るか確認する。
 */

interface HourlyWeather {
  time: string[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  precipitation: number[];
}

function loadWeather(): Record<string, HourlyWeather> {
  const p = path.join(process.cwd(), "scripts", "data", "venue_weather.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

function toHourKey(kaisaiDate: string, startTime: string | null): string | null {
  if (!startTime) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(startTime.trim());
  if (!m) return null;
  const y = kaisaiDate.slice(0, 4);
  const mo = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  const hh = m[1].padStart(2, "0");
  return `${y}-${mo}-${d}T${hh}:00`;
}

function windSpeedMs(kmh: number): number {
  return kmh / 3.6;
}

function bucketOf(ms: number): string {
  if (ms < 2) return "0-2m/s";
  if (ms < 4) return "2-4m/s";
  return "4m/s+";
}

async function main() {
  const weather = loadWeather();
  const db = getDb();

  const rows = await db.execute(`
    SELECT ra.id race_id, ra.kaisai_date, ra.jocd, ra.start_time,
           e.line_position, r.finish_pos, rc.kyakushitsu
    FROM races ra
    JOIN entries e ON e.race_id = ra.id
    JOIN results r ON r.race_id = ra.id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL AND rc.kyakushitsu IS NOT NULL
  `);
  const data = rows.rows as unknown as {
    race_id: number;
    kaisai_date: string;
    jocd: string;
    start_time: string | null;
    line_position: string | null;
    finish_pos: number;
    kyakushitsu: string;
  }[];
  console.log(`対象エントリ: ${data.length}件`);

  // bucket -> kyakushitsu -> {races, wins}
  const stats = new Map<string, Map<string, { n: number; wins: number }>>();
  // 番手・3番手のみに絞った同様の集計（風除けを使う側の脚質別）
  const statsNonSenko = new Map<string, Map<string, { n: number; wins: number }>>();

  let matched = 0;
  const weatherCache = new Map<string, number | null>(); // `${jocd}|${hourKey}` -> ms

  for (const row of data) {
    const hourKey = toHourKey(row.kaisai_date, row.start_time);
    if (!hourKey) continue;
    const cacheKey = `${row.jocd}|${hourKey}`;
    let ms = weatherCache.get(cacheKey);
    if (ms === undefined) {
      const w = weather[row.jocd];
      const idx = w ? w.time.indexOf(hourKey) : -1;
      ms = idx >= 0 ? windSpeedMs(w.wind_speed_10m[idx]) : null;
      weatherCache.set(cacheKey, ms);
    }
    if (ms == null) continue;
    matched++;
    const bucket = bucketOf(ms);
    const win = row.finish_pos === 1;

    const inner = stats.get(bucket) ?? new Map<string, { n: number; wins: number }>();
    const cell = inner.get(row.kyakushitsu) ?? { n: 0, wins: 0 };
    cell.n++;
    if (win) cell.wins++;
    inner.set(row.kyakushitsu, cell);
    stats.set(bucket, inner);

    if (row.line_position && row.line_position !== "先頭") {
      const inner2 = statsNonSenko.get(bucket) ?? new Map<string, { n: number; wins: number }>();
      const cell2 = inner2.get(row.kyakushitsu) ?? { n: 0, wins: 0 };
      cell2.n++;
      if (win) cell2.wins++;
      inner2.set(row.kyakushitsu, cell2);
      statsNonSenko.set(bucket, inner2);
    }
  }
  console.log(`風データ突合: ${matched}件\n`);

  const bucketOrder = ["0-2m/s", "2-4m/s", "4m/s+"];
  const kTypes = ["逃", "両", "追"];

  function printTable(title: string, source: Map<string, Map<string, { n: number; wins: number }>>) {
    console.log(title);
    console.log("風速帯".padEnd(10) + kTypes.map((k) => k.padStart(18)).join(""));
    for (const bucket of bucketOrder) {
      const inner = source.get(bucket);
      const cells = kTypes.map((k) => {
        const c = inner?.get(k);
        if (!c || c.n === 0) return "-".padStart(18);
        const rate = ((c.wins / c.n) * 100).toFixed(1);
        return `${rate}%(${c.wins}/${c.n})`.padStart(18);
      });
      console.log(bucket.padEnd(10) + cells.join(""));
    }
    console.log();
  }

  printTable("■ 全体（脚質別勝率 × 風速帯）:", stats);
  printTable("■ 番手・3番手のみ（先頭以外、風除けを使う側）:", statsNonSenko);
}

main();
