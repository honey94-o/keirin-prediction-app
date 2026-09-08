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
import { CLASS_RANK_SCORES } from "../lib/scoring";

/**
 * ユーザー依頼「本命の買い目を厳選する方向に舵を切りたい」を受けて、外部の
 * キーリン予想手法を調査（須田鷹雄氏の予想論、keirin-brother.com等）した結果、
 * 「本命のライン力は先頭選手のスコアだけでなく、番手選手のスコアの低い方で
 * 決まる」という考え方（二人揃って強くないと信頼できない）が繰り返し
 * 言及されていた。これをこのアプリの既存データだけで検証できるか確認する
 * （新しいスクレイピングは不要）。
 *
 * 「スジ違い決着」（本命の先頭は強いのに番手が弱く、番手が続けず共倒れ気味に
 * なる）という失敗パターンが本当にデータに出るなら、番手が弱いラインの
 * 本命は勝率が低いはず。
 *
 * 手法：本命（総合1位）がline_position="先頭"で、同じラインに"番手"がいる
 * レースに絞り、番手のclass_rank（CLASS_RANK_SCORES換算）が本命自身の
 * class_rankと比べてどれだけ格下かで層別し、実際の本命単勝的中率を比較する。
 */

type Rec = {
  honmeiClassScore: number;
  markerClassScore: number;
  win: boolean;
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
        if (!prediction || prediction.scored.length < 2) return null;
        const { scored, race } = prediction;
        const honmei = scored[0];
        if (honmei.entry.line_position !== "先頭" || !honmei.entry.class_rank) return null;

        const marker = scored.find(
          (s) => s.entry.line_group === honmei.entry.line_group && s.entry.line_position === "番手"
        );
        if (!marker || !marker.entry.class_rank) return null;

        const honmeiClassScore = CLASS_RANK_SCORES[honmei.entry.class_rank];
        const markerClassScore = CLASS_RANK_SCORES[marker.entry.class_rank];
        if (honmeiClassScore == null || markerClassScore == null) return null;

        const raceResults = await getResultsForRace(raceId);
        const winnerCarNum = raceResults.find((r) => r.finish_pos === 1)?.car_num;
        if (winnerCarNum == null) return null;

        const rec: Rec = {
          honmeiClassScore,
          markerClassScore,
          win: winnerCarNum === honmei.entry.car_num,
          kaisaiDate: race.kaisai_date,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n判定対象（本命=先頭かつ同ラインに番手がいるレース）: ${records.length}件\n`);

  function winRate(data: Rec[]): string {
    return data.length > 0 ? `${((data.filter((r) => r.win).length / data.length) * 100).toFixed(1)}%(n=${data.length})` : "-";
  }

  // 番手が本命よりどれだけ格下か（class_rankスコアの差）
  const gapBuckets = [
    { label: "番手が格上/同格", filter: (r: Rec) => r.markerClassScore >= r.honmeiClassScore },
    { label: "番手が少し格下(差15以内)", filter: (r: Rec) => r.honmeiClassScore - r.markerClassScore > 0 && r.honmeiClassScore - r.markerClassScore <= 15 },
    { label: "番手が大きく格下(差15超)", filter: (r: Rec) => r.honmeiClassScore - r.markerClassScore > 15 },
  ];

  console.log("■ 番手の格差別 本命単勝的中率");
  for (const b of gapBuckets) {
    console.log(`  [全体] ${b.label}: ${winRate(records.filter(b.filter))}`);
  }

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  const trainAll = records.filter((r) => r.kaisaiDate < splitDate);
  const testAll = records.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("--- train/testホールドアウト ---");
  for (const b of gapBuckets) {
    console.log(`  ${b.label}: train ${winRate(trainAll.filter(b.filter))} / test ${winRate(testAll.filter(b.filter))}`);
  }

  // 絶対値（番手自身のclass_rankスコア）でも見る（本命が強くても番手が絶対的に弱いケース）
  console.log("\n■ 番手自身の強さ別 本命単勝的中率（絶対値、CLASS_RANK_SCORES）");
  const absBuckets = [
    { label: "番手スコア<40(A2以下相当)", filter: (r: Rec) => r.markerClassScore < 40 },
    { label: "番手スコア40-70", filter: (r: Rec) => r.markerClassScore >= 40 && r.markerClassScore < 70 },
    { label: "番手スコア>=70(S1以上相当)", filter: (r: Rec) => r.markerClassScore >= 70 },
  ];
  for (const b of absBuckets) {
    console.log(`  [全体] ${b.label}: ${winRate(records.filter(b.filter))}`);
  }
  console.log("  --- train/testホールドアウト ---");
  for (const b of absBuckets) {
    console.log(`  ${b.label}: train ${winRate(trainAll.filter(b.filter))} / test ${winRate(testAll.filter(b.filter))}`);
  }
}

main();
