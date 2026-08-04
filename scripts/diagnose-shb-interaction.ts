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

type Entry = {
  race_id: number;
  car_num: number;
  back_lead_count: number | null;
  nige: number | null;
  makuri: number | null;
  sashi: number | null;
  mark: number | null;
  kyakushitsu: string | null;
};
type Result = { race_id: number; car_num: number; finish_pos: number | null; kimarite: string | null };

function nigeShareBucket(e: Entry): string {
  const nige = e.nige ?? 0;
  const total = (e.nige ?? 0) + (e.makuri ?? 0) + (e.sashi ?? 0) + (e.mark ?? 0);
  if (total === 0) return "実績なし";
  const share = nige / total;
  if (share >= 0.5) return "逃げ比率高(50%+)";
  if (share >= 0.2) return "逃げ比率中(20-50%)";
  return "逃げ比率低(<20%)";
}

async function main() {
  const db = getDb();

  const entriesRes = await db.execute(`
    SELECT e.race_id, e.car_num, rc.back_lead_count as back_lead_count,
           rc.kimarite_nige_count as nige, rc.kimarite_makuri_count as makuri,
           rc.kimarite_sashi_count as sashi, rc.kimarite_mark_count as mark,
           rc.kyakushitsu as kyakushitsu
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    WHERE rc.back_lead_count IS NOT NULL
  `);
  const entries = entriesRes.rows as unknown as Entry[];

  const resultsRes = await db.execute(`
    SELECT race_id, car_num, finish_pos, kimarite FROM results WHERE finish_pos IS NOT NULL
  `);
  const results = resultsRes.rows as unknown as Result[];

  const byRaceEntries = new Map<number, Entry[]>();
  for (const e of entries) {
    const arr = byRaceEntries.get(e.race_id) ?? [];
    arr.push(e);
    byRaceEntries.set(e.race_id, arr);
  }
  const byRaceResults = new Map<number, Result[]>();
  for (const r of results) {
    const arr = byRaceResults.get(r.race_id) ?? [];
    arr.push(r);
    byRaceResults.set(r.race_id, arr);
  }

  // バケット別: topB選手が①逃げ切り成功(1着かつ決まり手=逃) ②連対はしたが逃げ切れず(2着以下)
  // ③着外、の内訳。特に「逃げ比率高いのに連対止まり/着外」＝差し/まくりに交わされた
  // 可能性が高いケースの割合を見る。
  type Stat = { total: number; nigeWin: number; podiumNotWin: number; offPodium: number; caughtBySashiOrMakuri: number };
  const buckets = new Map<string, Stat>();
  const kyakuBuckets = new Map<string, Stat>();

  function bump(map: Map<string, Stat>, key: string, topBResult: Result, winner: Result) {
    const s = map.get(key) ?? { total: 0, nigeWin: 0, podiumNotWin: 0, offPodium: 0, caughtBySashiOrMakuri: 0 };
    s.total++;
    if (topBResult.finish_pos === 1) {
      s.nigeWin++;
    } else if (topBResult.finish_pos != null && topBResult.finish_pos <= 3) {
      s.podiumNotWin++;
      if (winner.kimarite === "差" || winner.kimarite === "捲") s.caughtBySashiOrMakuri++;
    } else {
      s.offPodium++;
      if (winner.kimarite === "差" || winner.kimarite === "捲") s.caughtBySashiOrMakuri++;
    }
    map.set(key, s);
  }

  let racesChecked = 0;
  for (const [raceId, raceEntries] of byRaceEntries) {
    const raceResults = byRaceResults.get(raceId);
    if (!raceResults || raceResults.length < 3) continue;
    const withB = raceEntries.filter((e) => e.back_lead_count != null);
    if (withB.length < 2) continue;

    const sorted = [...withB].sort(
      (a, b) => (b.back_lead_count as number) - (a.back_lead_count as number) || a.car_num - b.car_num
    );
    const topB = sorted[0];
    const bucket = nigeShareBucket(topB);
    const kyakuBucket = topB.kyakushitsu ?? "不明";

    const topBResult = raceResults.find((r) => r.car_num === topB.car_num);
    const winner = raceResults.find((r) => r.finish_pos === 1);
    if (!topBResult || !winner) continue;

    racesChecked++;
    bump(buckets, bucket, topBResult, winner);
    bump(kyakuBuckets, kyakuBucket, topBResult, winner);
  }

  console.log(`対象レース数: ${racesChecked}件（各レースのB最高選手を軸に集計）\n`);
  console.log("B最高選手の「逃げ決まり手比率」バケット別 実際の結果:");
  for (const key of ["逃げ比率高(50%+)", "逃げ比率中(20-50%)", "逃げ比率低(<20%)", "実績なし"]) {
    const s = buckets.get(key);
    if (!s) continue;
    console.log(
      `  ${key}: 母数${s.total} / 逃げ切り勝利${s.nigeWin}(${((s.nigeWin / s.total) * 100).toFixed(1)}%) ` +
        `/ 連対止まり${s.podiumNotWin} / 着外${s.offPodium} ` +
        `/ うち勝者が差・捲だった${s.caughtBySashiOrMakuri}件(${(((s.caughtBySashiOrMakuri) / s.total) * 100).toFixed(1)}%)`
    );
  }

  console.log("\nB最高選手の「脚質(kyakushitsu)」バケット別 実際の結果:");
  for (const key of ["逃", "両", "追", "不明"]) {
    const s = kyakuBuckets.get(key);
    if (!s) continue;
    console.log(
      `  ${key}: 母数${s.total} / 逃げ切り勝利${s.nigeWin}(${((s.nigeWin / s.total) * 100).toFixed(1)}%) ` +
        `/ 連対止まり${s.podiumNotWin} / 着外${s.offPodium} ` +
        `/ うち勝者が差・捲だった${s.caughtBySashiOrMakuri}件(${(((s.caughtBySashiOrMakuri) / s.total) * 100).toFixed(1)}%)`
    );
  }
}

main();
