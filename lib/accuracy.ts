import {
  getRace,
  getEntriesForRace,
  getPredictionsForRace,
  getResultsForRace,
  getOddsForRace,
  getRaceIdsWithPredictionAndResult,
  getRacesByDate,
} from "./repository";
import { generateBetSuggestionsFromRanking } from "./scoring";
import { todayJstStr, addDaysToDateStr } from "./date";
import type { AccuracyStats, DailySummary, RaceResultSummary } from "./types";

/**
 * 保存済み予想(predictions)と結果(results)を突き合わせ、
 * ◎の的中判定・3連単フォーメーションの的中判定・回収率を計算する。
 *
 * 回収率は「フォーメーションの各点に均等賭け（1点100円）した場合」を仮定し、
 * 的中点のオッズはpredictions保存時点近辺で記録されたoddsスナップショットを使う。
 * 公式の確定払戻金ではない参考値である点に注意。
 */
export async function getRaceResultSummary(raceId: number): Promise<RaceResultSummary | null> {
  const race = await getRace(raceId);
  if (!race) return null;

  const entries = await getEntriesForRace(raceId);
  const predictions = await getPredictionsForRace(raceId);
  const results = await getResultsForRace(raceId);

  const entrySummaries = entries.map((e) => ({ car_num: e.car_num, name: e.name }));

  if (predictions.length === 0 || results.length === 0) {
    return {
      race,
      entries: entrySummaries,
      predictions,
      results,
      honmeiHit: null,
      honmeiTop3: null,
      sanrentanHit: null,
      roi: null,
      payoutYen: null,
    };
  }

  const honmei = predictions.find((p) => p.mark === "◎");
  const resultByCar = new Map(results.map((r) => [r.car_num, r.finish_pos]));
  const honmeiFinish = honmei ? resultByCar.get(honmei.car_num) ?? null : null;
  const honmeiHit = honmeiFinish != null ? honmeiFinish === 1 : null;
  const honmeiTop3 = honmeiFinish != null ? honmeiFinish <= 3 : null;

  const actualOrder = [1, 2, 3].map(
    (pos) => results.find((r) => r.finish_pos === pos)?.car_num
  );
  const actualCombo =
    actualOrder.every((c) => c != null) ? actualOrder.join("-") : null;

  const ranked = [...predictions]
    .sort((a, b) => b.total_score - a.total_score)
    .map((p) => p.car_num);
  const suggestions = generateBetSuggestionsFromRanking(ranked);
  const formation = suggestions.find((s) => s.betType === "3連単フォーメーション");

  const sanrentanHit =
    actualCombo != null && formation != null
      ? formation.combinations.includes(actualCombo)
      : null;

  let roi: number | null = null;
  let payoutYen: number | null = null;
  if (actualCombo != null && formation != null && formation.combinations.length > 0) {
    const odds = (await getOddsForRace(raceId)).filter((o) => o.bet_type === "3連単");
    const stake = 100 * formation.combinations.length;
    const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;
    const payout = sanrentanHit && hitOdds != null ? 100 * hitOdds : 0;
    roi = (payout / stake) * 100;
    payoutYen = sanrentanHit && hitOdds != null ? payout : null;
  }

  return {
    race,
    entries: entrySummaries,
    predictions,
    results,
    honmeiHit,
    honmeiTop3,
    sanrentanHit,
    roi,
    payoutYen,
  };
}

function aggregateAccuracyStats(summaries: RaceResultSummary[]): AccuracyStats {
  const withHonmei = summaries.filter((s) => s.honmeiHit != null);
  const withSanrentan = summaries.filter((s) => s.sanrentanHit != null);
  const withRoi = summaries.filter((s) => s.roi != null);

  return {
    totalRaces: summaries.length,
    honmeiHitRate:
      withHonmei.length > 0
        ? (withHonmei.filter((s) => s.honmeiHit).length / withHonmei.length) * 100
        : null,
    honmeiTop3Rate:
      withHonmei.length > 0
        ? (withHonmei.filter((s) => s.honmeiTop3).length / withHonmei.length) * 100
        : null,
    sanrentanHitRate:
      withSanrentan.length > 0
        ? (withSanrentan.filter((s) => s.sanrentanHit).length / withSanrentan.length) * 100
        : null,
    overallRoi:
      withRoi.length > 0
        ? withRoi.reduce((sum, s) => sum + (s.roi ?? 0), 0) / withRoi.length
        : null,
  };
}

/**
 * 予想・結果が揃っている全レースを集計し、通算の的中率・回収率を算出する。
 */
export async function getOverallAccuracyStats(): Promise<AccuracyStats> {
  const raceIds = await getRaceIdsWithPredictionAndResult();
  const results = await Promise.all(raceIds.map((id) => getRaceResultSummary(id)));
  const summaries = results.filter((s): s is RaceResultSummary => s != null);
  return aggregateAccuracyStats(summaries);
}

/**
 * UTCで動くサーバー環境（GitHub Actions・Vercel）でも日本時間基準で
 * 「前日」を計算するためのヘルパー。競輪はJST基準の暦で開催されるため。
 */
export function yesterdayJst(): string {
  return addDaysToDateStr(todayJstStr(), -1);
}

/**
 * 指定日（YYYYMMDD）のレースだけを集計する（前日サマリー用）。
 * scripts/daily-summary.tsがGitHub Actions（daily-sync.yml）から日次実行し、
 * その日のレース分のpredictionsを事前に保存しておくことで、ここでは
 * 保存済みpredictions/results/oddsを読むだけの軽い処理になる
 * （毎回predictRaceで再計算すると1日分でもレース数が多く重いため）。
 */
export async function getDailySummary(statDate: string): Promise<DailySummary> {
  const races = await getRacesByDate(statDate);
  const results = await Promise.all(races.map((r) => getRaceResultSummary(r.id)));
  // getRacesByDateはその日の全レース（結果未確定分も含む）を返すため、
  // 予想・結果の両方が揃っている（honmeiHitが判定済みの）レースだけに絞る。
  // そうしないと「結果確定レース数」に未確定分が混ざってしまう。
  const summaries = results.filter(
    (s): s is RaceResultSummary => s != null && s.honmeiHit != null
  );
  const stats = aggregateAccuracyStats(summaries);

  const topPayouts = summaries
    .filter((s) => s.sanrentanHit && s.payoutYen != null)
    .sort((a, b) => (b.payoutYen ?? 0) - (a.payoutYen ?? 0))
    .slice(0, 5)
    .map((s) => {
      const actualOrder = [1, 2, 3].map(
        (pos) => s.results.find((r) => r.finish_pos === pos)?.car_num
      );
      return {
        race: s.race,
        combo: actualOrder.join("-"),
        payoutYen: s.payoutYen as number,
      };
    });

  return { ...stats, statDate, topPayouts };
}
