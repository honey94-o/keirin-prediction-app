import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// next dev/buildは.env.localを自動で読むが、tsx単体では読まれないため手動でロードする。
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

import { predictRace } from "../lib/predict";
import { getRacesByDate, getResultsForRace, savePrediction } from "../lib/repository";
import { getDailySummary, yesterdayJst } from "../lib/accuracy";
import { addDaysToDateStr } from "../lib/date";

/** 過去何日分をさかのぼって処理するか（引数で日付を1件指定しない自動実行時）。
 *  /history画面で前日〜過去1週間分をさかのぼって閲覧できるようにするため、
 *  1日分だけでなく直近分もまとめて処理する（既に処理済みの日はpredictions
 *  保存がUPSERTなので再実行しても安全＝軽い無駄はあるが壊れない）。 */
const BACKFILL_DAYS = 7;

async function processDate(statDate: string): Promise<void> {
  console.log(`\n集計対象日: ${statDate}`);

  const races = await getRacesByDate(statDate);
  console.log(`対象レース数: ${races.length}件`);

  let saved = 0;
  for (const race of races) {
    const results = await getResultsForRace(race.id);
    const top3 = results.filter((r) => r.finish_pos != null && r.finish_pos <= 3);
    if (top3.length < 3) continue; // 結果未確定のレースはスキップ

    const prediction = await predictRace(race.id);
    if (!prediction || prediction.scored.length === 0) continue;

    await savePrediction(race.id, prediction.scored);
    saved++;
  }
  console.log(`予想を保存: ${saved}件`);

  const summary = await getDailySummary(statDate);
  console.log(`=== ${statDate} サマリー ===`);
  console.log(`結果確定レース: ${summary.totalRaces}件`);
  console.log(`◎単勝的中率: ${summary.honmeiHitRate?.toFixed(1) ?? "-"}%`);
  console.log(`◎複勝的中率: ${summary.honmeiTop3Rate?.toFixed(1) ?? "-"}%`);
  console.log(`3連単フォーメーション的中率: ${summary.sanrentanHitRate?.toFixed(1) ?? "-"}%`);
  console.log(`回収率: ${summary.overallRoi?.toFixed(1) ?? "-"}%`);
  console.log(`配当ベスト${summary.topPayouts.length}:`);
  for (const p of summary.topPayouts) {
    console.log(
      `  ${p.race.keirinjo_name}${p.race.race_no}R ${p.combo} 払戻${p.payoutYen.toFixed(0)}円`
    );
  }
}

async function main() {
  const explicitDate = process.argv[2];
  if (explicitDate) {
    await processDate(explicitDate);
    return;
  }

  const latest = yesterdayJst();
  for (let i = BACKFILL_DAYS - 1; i >= 0; i--) {
    await processDate(addDaysToDateStr(latest, -i));
  }
}

main();
