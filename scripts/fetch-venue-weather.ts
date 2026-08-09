import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * scripts/data/venue_coords.json の各開催場座標について、Open-Meteoの過去気象
 * アーカイブAPI（無料・APIキー不要、時間単位、風速・風向・降水量）から
 * DBの開催期間（2026-04-09〜2026-08-09）分をまとめて取得し、
 * scripts/data/venue_weather.json にキャッシュする。
 * 1開催場につき1回のAPI呼び出しで期間全体（時間単位）が返るため、39回のみで済む。
 */

const START_DATE = "2026-04-09";
const END_DATE = "2026-08-09";

interface VenueCoord {
  jocd: string;
  name: string;
  lat: number;
  lon: number;
}

interface HourlyWeather {
  time: string[]; // "2026-04-09T00:00" (Asia/Tokyo)
  wind_speed_10m: number[]; // km/h
  wind_direction_10m: number[]; // deg
  precipitation: number[]; // mm
}

async function fetchWeather(lat: number, lon: number): Promise<HourlyWeather | null> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&hourly=wind_speed_10m,wind_direction_10m,precipitation&timezone=Asia%2FTokyo`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  status=${res.status}`);
    return null;
  }
  const json = (await res.json()) as { hourly?: HourlyWeather };
  return json.hourly ?? null;
}

async function main() {
  const coordsPath = path.join(process.cwd(), "scripts", "data", "venue_coords.json");
  const venues = JSON.parse(readFileSync(coordsPath, "utf-8")) as VenueCoord[];

  const out: Record<string, HourlyWeather> = {};
  for (const v of venues) {
    const weather = await fetchWeather(v.lat, v.lon);
    if (!weather) {
      console.log(`  [失敗] ${v.name}(${v.jocd})`);
      continue;
    }
    out[v.jocd] = weather;
    console.log(`  ${v.name}(${v.jocd}): ${weather.time.length}時間分取得`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const outPath = path.join(process.cwd(), "scripts", "data", "venue_weather.json");
  writeFileSync(outPath, JSON.stringify(out), "utf-8");
  console.log(`\n${Object.keys(out).length}/${venues.length}開催場分を ${outPath} に保存しました。`);
}

main();
