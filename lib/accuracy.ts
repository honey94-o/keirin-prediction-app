import {
  getRacesByIds,
  getPredictionsForRaces,
  getResultsForRaces,
  getOddsForRaces,
  getRaceIdsWithPredictionAndResult,
  getRacesByDate,
} from "./repository";
import { generateBetSuggestionsFromRanking } from "./scoring";
import { todayJstStr, addDaysToDateStr } from "./date";
import type {
  AccuracyStats,
  DailySummary,
  OddsRow,
  PredictionRow,
  RaceResultSummary,
  RaceRow,
  ResultRow,
} from "./types";

/**
 * 保存済み予想(predictions)と結果(results)を突き合わせ、
 * ◎の的中判定・3連単フォーメーションの的中判定・回収率を計算する
 * （DB呼び出しは行わない純粋関数。呼び出し側でまとめて取得したデータを渡す）。
 *
 * 回収率は「フォーメーションの各点に均等賭け（1点100円）した場合」を仮定し、
 * 的中点のオッズはpredictions保存時点近辺で記録されたoddsスナップショットを使う。
 * 公式の確定払戻金ではない参考値である点に注意。
 */
function computeRaceSummary(
  race: RaceRow,
  predictions: PredictionRow[],
  results: ResultRow[],
  odds: OddsRow[]
): RaceResultSummary {
  if (predictions.length === 0 || results.length === 0) {
    return {
      race,
      entries: [],
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
    const stake = 100 * formation.combinations.length;
    const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;
    const payout = sanrentanHit && hitOdds != null ? 100 * hitOdds : 0;
    roi = (payout / stake) * 100;
    payoutYen = sanrentanHit && hitOdds != null ? payout : null;
  }

  return {
    race,
    entries: [],
    predictions,
    results,
    honmeiHit,
    honmeiTop3,
    sanrentanHit,
    roi,
    payoutYen,
  };
}

/**
 * 複数レース分の的中判定・回収率をまとめて計算する。races/predictions/results/odds
 * をIN句でバルク取得してから計算するため、レース数が増えてもDB往復は定数回で済む
 * （以前は1レースごとに4回DBを読んでいたため、300レースでページ表示が3分近く
 * かかっていた。バルク化してこの問題を解消した）。
 */
export async function getBulkRaceSummaries(raceIds: number[]): Promise<RaceResultSummary[]> {
  if (raceIds.length === 0) return [];
  const [racesMap, predictionsMap, resultsMap, oddsMap] = await Promise.all([
    getRacesByIds(raceIds),
    getPredictionsForRaces(raceIds),
    getResultsForRaces(raceIds),
    getOddsForRaces(raceIds),
  ]);

  const summaries: RaceResultSummary[] = [];
  for (const raceId of raceIds) {
    const race = racesMap.get(raceId);
    if (!race) continue;
    summaries.push(
      computeRaceSummary(
        race,
        predictionsMap.get(raceId) ?? [],
        resultsMap.get(raceId) ?? [],
        oddsMap.get(raceId) ?? []
      )
    );
  }
  return summaries;
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
 * 予想・結果が揃っている直近レースを集計し、的中率・回収率を算出する
 * （件数はgetRaceIdsWithPredictionAndResultのデフォルト上限＝直近300件）。
 */
export async function getOverallAccuracyStats(): Promise<AccuracyStats> {
  const raceIds = await getRaceIdsWithPredictionAndResult();
  const summaries = await getBulkRaceSummaries(raceIds);
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
 * 指定日（YYYYMMDD）のレースだけを集計する（日別サマリー用）。
 * scripts/daily-summary.tsがGitHub Actions（daily-sync.yml）から日次実行し、
 * 直近1週間分のレースのpredictionsを事前に保存しておくことで、ここでは
 * 保存済みpredictions/results/oddsをバルク取得するだけの軽い処理になる
 * （毎回predictRaceで再計算すると1日分でもレース数が多く重いため）。
 */
export async function getDailySummary(statDate: string): Promise<DailySummary> {
  const races = await getRacesByDate(statDate);
  const results = await getBulkRaceSummaries(races.map((r) => r.id));
  // getRacesByDateはその日の全レース（結果未確定分も含む）を返すため、
  // 予想・結果の両方が揃っている（honmeiHitが判定済みの）レースだけに絞る。
  // そうしないと「結果確定レース数」に未確定分が混ざってしまう。
  const summaries = results.filter((s) => s.honmeiHit != null);
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
