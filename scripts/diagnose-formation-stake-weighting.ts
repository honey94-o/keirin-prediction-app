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
import { predictRace } from "../lib/predict";
import { getResultsForRace, enableReadCache } from "../lib/repository";
import { buildLineAwarePool } from "../lib/scoring";

/**
 * 買い目研究（Mr.Tの競輪眼の実売買チケット等）で見つかった「同じフォーメーション内
 * でも並びごとに金額を傾斜配分する」手法をこのアプリでも検証できるか確認する。
 *
 * 現状のformationFromPoolは、buildLineAwarePool（lineupOrderScoreで並べた
 * 2-3着候補プール）の上位K人から作れる全順列に均等配点（100円/点）している。
 * プール内の順位（1位候補・2位候補…）ごとに、実際にその順位の選手が2着・3着に
 * 来る頻度に差があるなら、傾斜配点の余地がある。差が無ければ（プール内では
 * ほぼ横並び）、傾斜配点しても効果は薄い。
 *
 * 本命（軸）が実際に1着だったレースに絞り、buildLineAwarePoolの並び順
 * （1番目・2番目・3番目・4番目以降）別に、実際の2着・3着になった頻度を集計する。
 */

type Rec = {
  actual2ndPoolRank: number | null; // 1-indexed。プールに無ければnull
  actual3rdPoolRank: number | null;
  kaisaiDate: string;
};

async function main() {
  enableReadCache();
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  let raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit) raceIds = raceIds.slice(-limit);
  console.log(`対象レース: ${raceIds.length}件${limit ? `（直近${limit}件に絞り込み）` : ""}`);

  const records: Rec[] = [];
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scored.length < 3) return null;
        const { scored, race } = prediction;
        const honmei = scored[0];

        const raceResults = await getResultsForRace(raceId);
        const winnerCarNum = raceResults.find((r) => r.finish_pos === 1)?.car_num;
        if (winnerCarNum !== honmei.entry.car_num) return null; // 本命が1着の時だけ対象

        const second = raceResults.find((r) => r.finish_pos === 2)?.car_num;
        const third = raceResults.find((r) => r.finish_pos === 3)?.car_num;
        if (second == null || third == null) return null;

        const pool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored);
        const rank2 = pool.indexOf(second);
        const rank3 = pool.indexOf(third);

        const rec: Rec = {
          actual2ndPoolRank: rank2 >= 0 ? rank2 + 1 : null,
          actual3rdPoolRank: rank3 >= 0 ? rank3 + 1 : null,
          kaisaiDate: race.kaisai_date,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n本命が1着だったレース: ${records.length}件\n`);

  function printDist(data: Rec[], key: "actual2ndPoolRank" | "actual3rdPoolRank", label: string) {
    console.log(`■ ${label}`);
    const total = data.filter((r) => r[key] != null).length;
    for (const rank of [1, 2, 3, 4, 5]) {
      const count = data.filter((r) => r[key] === rank).length;
      console.log(`  プール${rank}番手: ${((count / total) * 100).toFixed(1)}% (${count}/${total})`);
    }
    const rest = data.filter((r) => r[key] != null && r[key]! > 5).length;
    console.log(`  プール6番手以降: ${((rest / total) * 100).toFixed(1)}% (${rest}/${total})`);
    const outOfPool = data.filter((r) => r[key] == null).length;
    console.log(`  （参考）プールに含まれなかった件数: ${outOfPool}/${data.length}`);
  }

  printDist(records, "actual2ndPoolRank", "実際の2着 → プール内の順位別頻度");
  console.log();
  printDist(records, "actual3rdPoolRank", "実際の3着 → プール内の順位別頻度");

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  const trainData = records.filter((r) => r.kaisaiDate < splitDate);
  const testData = records.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("\n--- train/testホールドアウト（実際の2着 → プール1番手 vs 2番手の頻度） ---");
  function rank1vs2(data: Rec[]): string {
    const total = data.filter((r) => r.actual2ndPoolRank != null).length;
    const r1 = data.filter((r) => r.actual2ndPoolRank === 1).length;
    const r2 = data.filter((r) => r.actual2ndPoolRank === 2).length;
    return `1番手${((r1 / total) * 100).toFixed(1)}% / 2番手${((r2 / total) * 100).toFixed(1)}% (n=${total})`;
  }
  console.log(`  [train] ${rank1vs2(trainData)}`);
  console.log(`  [test]  ${rank1vs2(testData)}`);
}

main();
