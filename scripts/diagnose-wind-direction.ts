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
 * scripts/diagnose-wind-kimarite.ts・-kyakushitsu.tsは風「速」だけを見ており
 * （十番目の発見、効果なし）、風「向き」は取得済みなのに一度も分析していなかった。
 * バンクの向き（直線がどちらを向いているか）のデータは無いため、開催場ごとに
 * 「絶対風向（8方位）」で決まり手分布が変わるかを見る（同じ開催場ならバンクの
 * 向きは固定なので、絶対風向と実際の追い風・向かい風は1対1で対応するはず。
 * どの方位が追い風になるかは分からないが、"方位によって分布が変わるか"は
 * 検証できる）。ただしOpen-Meteoの地域気象データが粗い（9-25km格子）という
 * 十番目の発見の限界はそのまま残るため、参考値として扱う。
 * scripts/data/venue_weather.json（4/9-8/9ぶんキャッシュ済み、再取得なし）を使う。
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

const OCTANTS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
function octantOf(deg: number): string {
  const idx = Math.round(deg / 45) % 8;
  return OCTANTS[idx];
}

async function main() {
  const weather = loadWeather();
  const db = getDb();

  const raceRows = await db.execute(`
    SELECT id, kaisai_date, jocd, keirinjo_name, start_time FROM races
    WHERE id IN (SELECT DISTINCT race_id FROM results WHERE finish_pos = 1)
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    jocd: string;
    keirinjo_name: string;
    start_time: string | null;
  }[];

  const winnerRows = await db.execute(
    `SELECT race_id, kimarite FROM results WHERE finish_pos = 1 AND kimarite IS NOT NULL`
  );
  const winnerByRace = new Map<number, string>();
  for (const r of winnerRows.rows as unknown as { race_id: number; kimarite: string }[]) {
    winnerByRace.set(r.race_id, r.kimarite);
  }

  // jocd -> octant -> kimarite -> count
  const byVenue = new Map<string, { name: string; data: Map<string, Map<string, number>> }>();
  let matched = 0;

  for (const race of races) {
    const kimarite = winnerByRace.get(race.id);
    if (!kimarite) continue;
    const hourKey = toHourKey(race.kaisai_date, race.start_time);
    const w = weather[race.jocd];
    if (!hourKey || !w) continue;
    const idx = w.time.indexOf(hourKey);
    if (idx === -1) continue;
    const dir = w.wind_direction_10m[idx];
    if (dir == null) continue;
    const octant = octantOf(dir);
    matched++;

    const venue = byVenue.get(race.jocd) ?? { name: race.keirinjo_name, data: new Map() };
    const inner = venue.data.get(octant) ?? new Map<string, number>();
    inner.set(kimarite, (inner.get(kimarite) ?? 0) + 1);
    venue.data.set(octant, inner);
    byVenue.set(race.jocd, venue);
  }
  console.log(`風向データ突合成功: ${matched}件\n`);

  const MIN_VENUE_TOTAL = 200;
  const kimariteTypes = ["逃", "捲", "差"];

  for (const [jocd, venue] of byVenue) {
    const total = [...venue.data.values()].reduce(
      (sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0),
      0
    );
    if (total < MIN_VENUE_TOTAL) continue;

    console.log(`■ ${venue.name}(jocd=${jocd}, n=${total})`);
    // 逃げ率が最も高い方位・低い方位のギャップを出す
    let maxNigeRate = -1;
    let minNigeRate = 2;
    let maxOctant = "";
    let minOctant = "";
    for (const octant of OCTANTS) {
      const inner = venue.data.get(octant);
      if (!inner) continue;
      const octTotal = [...inner.values()].reduce((a, b) => a + b, 0);
      if (octTotal < 15) continue; // 少なすぎる方位はノイズなので判定に使わない
      const nigeRate = (inner.get("逃") ?? 0) / octTotal;
      if (nigeRate > maxNigeRate) {
        maxNigeRate = nigeRate;
        maxOctant = octant;
      }
      if (nigeRate < minNigeRate) {
        minNigeRate = nigeRate;
        minOctant = octant;
      }
      const pcts = kimariteTypes
        .map((k) => `${k}${(((inner.get(k) ?? 0) / octTotal) * 100).toFixed(0)}%`)
        .join(" ");
      console.log(`  ${octant.padEnd(4)}(n=${octTotal}): ${pcts}`);
    }
    if (maxOctant && minOctant) {
      console.log(
        `  → 逃げ率が最も高い方位: ${maxOctant}(${(maxNigeRate * 100).toFixed(0)}%) / 最も低い方位: ${minOctant}(${(minNigeRate * 100).toFixed(0)}%)`
      );
    }
    console.log();
  }
}

main();
