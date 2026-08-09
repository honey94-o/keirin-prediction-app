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
 * Open-Meteoの過去気象データ（scripts/data/venue_weather.json、
 * fetch-venue-coords.ts + fetch-venue-weather.tsで取得済み）を実際のレース結果と
 * 突き合わせ、「風が強い日は決まり手（逃/捲/差）の分布が変わるか」を検証する。
 * ユーザーが「オッズEVは直前まで変動するので使いにくい」と判断した後の代替案。
 * 風予報は発走の数時間〜前日には安定して取得できるため、既存のcronタイミング
 * （5:00/17:00 JST）と相性が良い、という想定に基づく。
 *
 * まず「本当に风データが使えるか」を確認するのが目的なので、スコアリングには
 * 一切触れず、決まり手分布と風速帯の関係だけを見る。
 */

interface HourlyWeather {
  time: string[];
  wind_speed_10m: number[]; // km/h
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
  if (ms < 2) return "0-2m/s(穏やか)";
  if (ms < 4) return "2-4m/s(中程度)";
  return "4m/s+(強風)";
}

async function main() {
  const weather = loadWeather();
  const db = getDb();

  const raceRows = await db.execute(`
    SELECT id, kaisai_date, jocd, start_time FROM races
    WHERE id IN (SELECT DISTINCT race_id FROM results WHERE finish_pos = 1)
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    jocd: string;
    start_time: string | null;
  }[];
  console.log(`結果確定レース: ${races.length}件`);

  const winnerRows = await db.execute(`
    SELECT race_id, kimarite FROM results WHERE finish_pos = 1 AND kimarite IS NOT NULL
  `);
  const winnerByRace = new Map<number, string>();
  for (const r of winnerRows.rows as unknown as { race_id: number; kimarite: string }[]) {
    winnerByRace.set(r.race_id, r.kimarite);
  }

  const bucketStats = new Map<string, Map<string, number>>(); // bucket -> kimarite -> count
  const bucketTotal = new Map<string, number>();
  let matched = 0;
  let noWeather = 0;
  let noKimarite = 0;

  for (const race of races) {
    const kimarite = winnerByRace.get(race.id);
    if (!kimarite) {
      noKimarite++;
      continue;
    }
    const hourKey = toHourKey(race.kaisai_date, race.start_time);
    const w = weather[race.jocd];
    if (!hourKey || !w) {
      noWeather++;
      continue;
    }
    const idx = w.time.indexOf(hourKey);
    if (idx === -1) {
      noWeather++;
      continue;
    }
    const ms = windSpeedMs(w.wind_speed_10m[idx]);
    const bucket = bucketOf(ms);
    matched++;

    const inner = bucketStats.get(bucket) ?? new Map<string, number>();
    inner.set(kimarite, (inner.get(kimarite) ?? 0) + 1);
    bucketStats.set(bucket, inner);
    bucketTotal.set(bucket, (bucketTotal.get(bucket) ?? 0) + 1);
  }

  console.log(`風データ突合成功: ${matched}件 (天候データなし${noWeather}件, 決まり手なし${noKimarite}件)\n`);

  const bucketOrder = ["0-2m/s(穏やか)", "2-4m/s(中程度)", "4m/s+(強風)"];
  const kimariteTypes = ["逃", "捲", "差", "マ"];

  console.log("風速帯別 決まり手分布（%）:");
  console.log("風速帯".padEnd(16) + "件数".padStart(6) + kimariteTypes.map((k) => k.padStart(8)).join(""));
  for (const bucket of bucketOrder) {
    const inner = bucketStats.get(bucket);
    const total = bucketTotal.get(bucket) ?? 0;
    if (!inner || total === 0) {
      console.log(`${bucket.padEnd(16)}${"0".padStart(6)}  データなし`);
      continue;
    }
    const pcts = kimariteTypes.map((k) => {
      const c = inner.get(k) ?? 0;
      return `${((c / total) * 100).toFixed(1)}%`.padStart(8);
    });
    console.log(`${bucket.padEnd(16)}${String(total).padStart(6)}${pcts.join("")}`);
  }
}

main();
