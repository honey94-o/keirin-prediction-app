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
import { predictRace, prefetchRaceInputs } from "../lib/predict";
import {
  getRacesByDate,
  getRacesWithoutPrediction,
  getResultsForRaces,
  savePredictions,
  enableReadCache,
} from "../lib/repository";
import { getDailySummary, yesterdayJst } from "../lib/accuracy";
import { addDaysToDateStr } from "../lib/date";
import { closeDb } from "../lib/db";

/** 過去何日分をさかのぼって処理するか（引数で日付を1件指定しない自動実行時）。
 *  /history画面で前日〜過去1週間分をさかのぼって閲覧できるようにするため、
 *  1日分だけでなく直近分もまとめて見る（結果の取り込みが遅れたレースも、
 *  予想が保存されるまで毎朝拾い直すため取りこぼさない）。 */
const BACKFILL_DAYS = 7;

/**
 * 【予想を保存済みのレースは計算し直さない】
 * 以前は毎朝、直近7日分の結果確定レース（約500件）すべてにpredictRaceを呼び直して
 * 保存済みの予想も上書きしていた。1レースずつ・1クエリずつ順番に待つ構造だったため
 * Neonへの往復が約18,000回積み上がって約10分かかり、転送量も1回で約15MB使っていた。
 * predictionsは一度保存したら固定して残すスナップショット（画面の「予想を記録」で
 * 発走前に保存したものも含む）なので、まだ1行も保存されていない結果確定レースだけを
 * 対象にする。ロジック変更後などに作り直したいときは --force を付ける
 * （対象日の結果確定レースを全て計算し直して上書きする＝従来の動作）。
 */
async function processDate(statDate: string, opts: { force: boolean; alwaysSummarize: boolean }): Promise<void> {
  console.log(`
集計対象日: ${statDate}`);

  const candidates = opts.force ? await getRacesByDate(statDate) : await getRacesWithoutPrediction(statDate);
  // 結果はレースごとに1クエリずつではなくまとめて取る
  const resultsByRace = await getResultsForRaces(candidates.map((race) => race.id));
  const finished = candidates.filter((race) => {
    const top3 = (resultsByRace.get(race.id) ?? []).filter((r) => r.finish_pos != null && r.finish_pos <= 3);
    return top3.length >= 3; // 結果未確定のレースはスキップ
  });
  console.log(
    `${opts.force ? "対象レース数" : "予想未保存のレース数"}: ${candidates.length}件（うち結果確定${finished.length}件）`
  );

  // 出走表・選手履歴等を数クエリにまとめて先読みしてから、並列に予想する。
  await prefetchRaceInputs(finished);
  const predictions = await Promise.all(finished.map((race) => predictRace(race.id)));
  const items = finished.flatMap((race, i) => {
    const prediction = predictions[i];
    if (!prediction || prediction.scored.length === 0) return [];
    const honmeiFormation = prediction.scenarios.find((s) => s.label === "本命")?.formation.combinations;
    return [{ raceId: race.id, scored: prediction.scored, honmeiFormation }];
  });
  await savePredictions(items);
  console.log(`予想を保存: ${items.length}件`);

  // サマリーはこのログに出すだけ（/history画面は表示時に自前で集計する）なので、
  // 新たに保存した予想が無く前回の実行から変わっていない日は集計し直さない。
  if (items.length === 0 && !opts.alwaysSummarize) return;
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
  // 同じ選手・開催場の集計を全レースぶん引き直すのを防ぐ（Neonの転送量削減）。
  enableReadCache();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const explicitDate = args.find((a) => !a.startsWith("--"));
  if (explicitDate) {
    await processDate(explicitDate, { force, alwaysSummarize: true });
    // pg.PoolはデフォルトでidleTimeoutMillis=10000msのため、明示的にend()しないと
    // 計算後もアイドルタイムアウトまでプロセスが終了できない（lib/db.tsのcloseDb参照）。
    await closeDb();
    return;
  }

  const latest = yesterdayJst();
  for (let i = BACKFILL_DAYS - 1; i >= 0; i--) {
    // 前日分のサマリーは保存件数に関わらず毎朝ログに出す
    await processDate(addDaysToDateStr(latest, -i), { force, alwaysSummarize: i === 0 });
  }
  await closeDb();
}

main();
