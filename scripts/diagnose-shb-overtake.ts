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

/**
 * ユーザー依頼「選手個々の特徴（例：飛びつきが多い）を読み取れないか」を受けて、
 * 「飛びつき」（他ラインの番手/3番手を奪う動き）そのものは記録されたデータが
 * 無く直接検証できないが、近い性質を持つ既存データ（S/H/B、standing_count・
 * home_lead_count・back_lead_count）で代替検証できるか確認する。
 *
 * scripts/diagnose-development-forecast-validity.ts、diagnose-kimarite-prediction.ts
 * と2連続で「個人の過去データからレース展開を予想する」試みが失敗している
 * （train/testで方向が逆転する典型的なノイズ）ため、3回目は的を絞る：
 * 「番手/3番手選手が、後ろから前を奪う（＝自分のラインの先頭より良い着順で
 * ゴールする）動き」を、個人のback_lead_count（最終周回バック線を先頭通過した
 * 回数、＝終盤に前に出る積極性の実測値）が予測できるかを見る。
 *
 * 注意：racers.back_lead_count等は現時点の最新値で選手ごとに毎回上書きされ、
 * レース単位の履歴を持たない（既知の制約、diagnose-kimarite-prediction.ts参照）。
 */

type Rec = {
  backLeadCount: number;
  standingCount: number;
  overtookOwnSenko: boolean; // 自分のラインの先頭より良い着順でゴールしたか
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
        if (!prediction || prediction.scored.length < 3) return [];
        const { scored, race } = prediction;

        const raceResults = await getResultsForRace(raceId);
        const finishByCarNum = new Map(raceResults.map((r) => [r.car_num, r.finish_pos]));

        const recs: Rec[] = [];
        for (const s of scored) {
          if (s.entry.line_position !== "番手" && s.entry.line_position !== "3番手") continue;
          if (s.entry.back_lead_count == null || s.entry.standing_count == null) continue;

          const senko = scored.find(
            (x) => x.entry.line_group === s.entry.line_group && x.entry.line_position === "先頭"
          );
          if (!senko) continue;
          const myFinish = finishByCarNum.get(s.entry.car_num);
          const senkoFinish = finishByCarNum.get(senko.entry.car_num);
          if (myFinish == null || senkoFinish == null) continue;

          recs.push({
            backLeadCount: s.entry.back_lead_count,
            standingCount: s.entry.standing_count,
            overtookOwnSenko: myFinish < senkoFinish,
            kaisaiDate: race.kaisai_date,
          });
        }
        return recs;
      })
    );
    for (const recs of results) records.push(...recs);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n判定対象（番手/3番手、S/H/Bデータあり）: ${records.length}件\n`);

  function rate(data: Rec[]): string {
    return data.length > 0
      ? `${((data.filter((r) => r.overtookOwnSenko).length / data.length) * 100).toFixed(1)}%(n=${data.length})`
      : "-";
  }

  const sorted = [...records].sort((a, b) => a.backLeadCount - b.backLeadCount);
  const tertileSize = Math.floor(sorted.length / 3);
  const tertiles = [
    { label: "back_lead_count下位1/3", data: sorted.slice(0, tertileSize) },
    { label: "back_lead_count中位1/3", data: sorted.slice(tertileSize, tertileSize * 2) },
    { label: "back_lead_count上位1/3", data: sorted.slice(tertileSize * 2) },
  ];
  console.log("■ 個人back_lead_count別 → 自分のライン先頭を上回ってゴールした率");
  for (const t of tertiles) {
    console.log(`  [全体] ${t.label}: ${rate(t.data)}`);
  }

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("--- train/testホールドアウト（上位1/3 vs 下位1/3）---");
  const lowTrain = tertiles[0].data.filter((r) => r.kaisaiDate < splitDate);
  const lowTest = tertiles[0].data.filter((r) => r.kaisaiDate >= splitDate);
  const highTrain = tertiles[2].data.filter((r) => r.kaisaiDate < splitDate);
  const highTest = tertiles[2].data.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`  [train] 下位${rate(lowTrain)} / 上位${rate(highTrain)}`);
  console.log(`  [test]  下位${rate(lowTest)} / 上位${rate(highTest)}`);

  // standing_count（好スタート回数）でも同様に見る
  const sortedByStanding = [...records].sort((a, b) => a.standingCount - b.standingCount);
  const sTertileSize = Math.floor(sortedByStanding.length / 3);
  const sTertiles = [
    { label: "standing_count下位1/3", data: sortedByStanding.slice(0, sTertileSize) },
    { label: "standing_count中位1/3", data: sortedByStanding.slice(sTertileSize, sTertileSize * 2) },
    { label: "standing_count上位1/3", data: sortedByStanding.slice(sTertileSize * 2) },
  ];
  console.log("\n■ 個人standing_count別 → 自分のライン先頭を上回ってゴールした率");
  for (const t of sTertiles) {
    console.log(`  [全体] ${t.label}: ${rate(t.data)}`);
  }
  console.log("--- train/testホールドアウト（上位1/3 vs 下位1/3）---");
  const sLowTrain = sTertiles[0].data.filter((r) => r.kaisaiDate < splitDate);
  const sLowTest = sTertiles[0].data.filter((r) => r.kaisaiDate >= splitDate);
  const sHighTrain = sTertiles[2].data.filter((r) => r.kaisaiDate < splitDate);
  const sHighTest = sTertiles[2].data.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`  [train] 下位${rate(sLowTrain)} / 上位${rate(sHighTrain)}`);
  console.log(`  [test]  下位${rate(sLowTest)} / 上位${rate(sHighTest)}`);
}

main();
