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

import { predictRace, prefetchRaceInputs } from "../lib/predict";
import {
  getRacesByDate,
  getScoreWeights,
  saveDailyPicks,
  saveBarikataPicks,
  saveBarikataNearMisses,
  saveNakaanaPicks,
  deleteStalePicks,
  enableReadCache,
} from "../lib/repository";
import { todayJstStr, addDaysToDateStr, nowJstHHMM } from "../lib/date";
import { closeDb } from "../lib/db";
import { saveRaceSnapshots, snapshotFromPrediction } from "../lib/race-snapshot";
import { buildPicks, hasRaceStarted } from "./lib/picks";

/**
 * 「厳選」（daily_picks）「バリカタ」（barikata_picks/barikata_near_misses）
 * 「中穴候補」（nakaana_picks）をまとめて計算する。
 *
 * 元は scripts/daily-picks.ts と scripts/barikata-picks.ts の2本に分かれて
 * いたが、どちらも同じ日の同じレース群に対して独立に predictRace を呼んでおり
 * （1レースあたりDB約20回、選手単位のクエリはenableReadCache()でも重複排除
 * されない）、実質的に同じ計算を2回行っていた。データ更新の高速化調査
 * （2026-09）で「1日あたり約25-30秒の完全な無駄」と判明したため、1本の
 * predictions配列を計算し3種類のピック生成に使い回す形に統合した。
 * 各ピックの選定条件・検証根拠は元のコメントをそのまま引き継いでいる
 * （選定ロジック本体は scripts/lib/picks.ts の buildPicks に移した）。
 *
 * 【発走済みのレースは計算し直さない】
 * 以前は1日4回＋手動実行のたびに当日・翌日の全レースを計算し直しており、発走済み・
 * 結果確定済みのレースまでレース後の選手成績（racersは結果取り込みで更新される）で
 * 計算し直して上書きしていた。ピックは「発走前に実際に見せたもの」のスナップショット
 * （/history・前日の結果の的中判定に使う）なので、発走後に書き換えるのは正しさの面でも
 * 問題があり、転送量・計算の面でも無駄だった。各save関数はrace_id単位のUPSERTで
 * 日付ごとの洗い替えはしないため、計算対象から外したレースの行は前回の値のまま残る。
 */
async function processDate(kaisaiDate: string, nowHHMM: string | null): Promise<void> {
  const allRaces = await getRacesByDate(kaisaiDate);
  const races = nowHHMM ? allRaces.filter((race) => !hasRaceStarted(race, nowHHMM)) : allRaces;
  const skipped = allRaces.length - races.length;
  console.log(
    `${kaisaiDate}: 対象レース${races.length}件` + (skipped > 0 ? `（発走済み${skipped}件は前回の値を据え置き）` : "")
  );
  if (races.length === 0) return;

  // 出走表・選手履歴等を開催日単位で数クエリにまとめて先読みしてから予想する
  // （predictRaceを1レースずつ呼ぶだけだと1回の実行で約4,000クエリになっていた）。
  await prefetchRaceInputs(races);
  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));
  const { dailyPicks, barikataPicks, barikataNearMisses, nakaanaPicks } = buildPicks(races, predictions);
  // 全レースの予想スナップショット（lib/race-snapshot.ts）。ホーム・/picks・開催場ページが
  // 表示のたびにpredictRaceを実行しないで済むよう、同じ予想結果からついでに保存する。
  // 重みはpredictRaceが使ったのと同じ値（読取キャッシュ済みなので追加のクエリは無い）。
  const weights = await getScoreWeights();
  const snapshots = races.flatMap((race, i) => {
    const prediction = predictions[i];
    return prediction ? [snapshotFromPrediction(race.id, prediction, weights)] : [];
  });

  // 各テーブルは互いに独立なので、往復待ちを直列に積まないよう同時に書く
  await Promise.all([
    saveDailyPicks(dailyPicks),
    saveBarikataPicks(barikataPicks),
    saveBarikataNearMisses(barikataNearMisses),
    saveNakaanaPicks(nakaanaPicks),
    // テーブル（scripts/migrate-race-snapshots.tsで作る）が未作成でも厳選等の保存・削除は
    // 止めない（画面側は行が無ければpredictRaceで代替表示する）。
    saveRaceSnapshots(kaisaiDate, snapshots).catch((err) =>
      console.warn(`  race_snapshotsの保存に失敗（マイグレーション未実行？）: ${err instanceof Error ? err.message : err}`)
    ),
  ]);
  await deleteStalePicks(
    races.map((r) => r.id),
    {
      daily: dailyPicks.map((p) => p.raceId),
      barikata: barikataPicks.map((p) => p.raceId),
      nearMiss: barikataNearMisses.map((p) => p.raceId),
      nakaana: nakaanaPicks.map((p) => p.raceId),
    }
  );
  console.log(
    `  厳選: ${dailyPicks.length}件 / バリカタ: ${barikataPicks.length}件 / ` +
      `候補漏れ: ${barikataNearMisses.length}件 / 中穴候補: ${nakaanaPicks.length}件 / ` +
      `予想スナップショット: ${snapshots.length}件`
  );
}

async function main() {
  // 同じ選手・開催場の集計を全レースぶん引き直すのを防ぐ（Neonの転送量削減）。
  enableReadCache();

  const today = todayJstStr();
  const tomorrow = addDaysToDateStr(today, 1);
  const start = Date.now();
  await processDate(today, nowJstHHMM());
  await processDate(tomorrow, null);
  console.log(`完了 (${Date.now() - start}ms)`);
  // pg.PoolはデフォルトでidleTimeoutMillis=10000msのため、明示的にend()しないと
  // 計算後もアイドルタイムアウトまでプロセスが終了できない（lib/db.tsのcloseDb参照）。
  await closeDb();
}

main();
