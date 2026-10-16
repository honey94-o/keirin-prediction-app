/**
 * 予想履歴（/history・/history/[date]）用のDB読み取り。lib/queries/race.ts と同じく
 * 全てcachedQuery経由（ISRページのHTMLにタグなしの値を焼き付けないため）。
 *
 * 旧実装は1回の表示で約115クエリ・約2MB転送していた（直近300レースの予想・結果を
 * 通算成績・ガールズ成績・一覧のために3回、日別サマリーのために2回取り直し、
 * 14日ぶんの厳選履歴は日付ごとに直列で6クエリずつ）。ここでは
 *   - 同じレース集合の取得は1回にまとめ、集計はlib/accuracy.tsの関数で行う
 *   - 予想(predictions)は◎行だけ・結果(results)は判定に使う行だけをDB側で絞る
 *   - 14日ぶんの厳選・バリカタは日付をまとめて取る
 * ことで、表示内容は同じまま転送量とクエリ数を減らしている。
 */
import { getDb } from "../db";
import { cachedQuery, CACHE_TAGS } from "../cache";
import { aggregateAccuracyStats, buildDailySummary, computeRaceSummary } from "../accuracy";
import {
  DAILY_PICKS_MAX_MARGIN,
  DAILY_PICKS_MIN_MARGIN,
  getBarikataPicksResults,
  getDailyPicksResults,
  getOddsForRaces,
  getRaceIdsWithPrediction,
  getRaceIdsWithPredictionAndResult,
  getResultsForRaces,
  resolveActualCombo,
} from "../repository";
import type {
  AccuracyStats,
  BarikataPickResult,
  DailyPickResult,
  DailySummary,
  OddsRow,
  PredictionRow,
  RaceResultSummary,
  RaceRow,
  ResultRow,
} from "../types";

const { races: RACES, results: RESULTS, picks: PICKS } = CACHE_TAGS;

function groupByRace<T extends { race_id: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const arr = map.get(row.race_id) ?? [];
    arr.push(row);
    map.set(row.race_id, arr);
  }
  return map;
}

/**
 * lib/accuracy.ts getBulkRaceSummaries と同じ結果を、computeRaceSummaryが実際に読む行だけで作る。
 *   - races: 履歴画面が表示に使う列だけ（RaceRowの他の列はこの関数の外に出さない）
 *   - predictions: ◎（先頭の◎にformationがあればそれだけで的中判定できる）。formationが無い
 *     古い予想・◎が無いレースは総合スコア順の簡易フォーメーションを作るため全行を取る
 *   - results: 1〜3着と◎の行（＋0件判定を変えないための1行）
 */
async function getRaceSummaries(raceIds: number[]): Promise<RaceResultSummary[]> {
  if (raceIds.length === 0) return [];
  const db = getDb();
  const [racesRes, predictionsRes, resultsRes, oddsRes, girlsRes] = await Promise.all([
    db.execute({
      sql: "SELECT id, kaisai_date, keirinjo_name, race_no FROM races WHERE id = ANY(?::int[])",
      args: [raceIds],
    }),
    db.execute({
      sql: `WITH honmei AS (
              SELECT DISTINCT ON (race_id) race_id, formation FROM predictions
              WHERE race_id = ANY(?::int[]) AND mark = '◎'
              ORDER BY race_id, total_score DESC
            )
            SELECT p.race_id, p.car_num, p.snum, p.mark, p.total_score, p.line_score, p.kyakushitsu_score,
                   p.stats_score, p.formation
            FROM predictions p
            LEFT JOIN honmei h ON h.race_id = p.race_id
            WHERE p.race_id = ANY(?::int[]) AND (COALESCE(h.formation, '') = '' OR p.mark = '◎')
            ORDER BY p.race_id, p.total_score DESC`,
      args: [raceIds, raceIds],
    }),
    db.execute({
      sql: `SELECT r.race_id, r.car_num, r.snum, r.finish_pos, r.kimarite FROM results r
            WHERE r.race_id = ANY(?::int[])
              AND (r.finish_pos <= 3
                   OR r.car_num IN (SELECT p.car_num FROM predictions p WHERE p.race_id = r.race_id AND p.mark = '◎')
                   OR r.car_num = (SELECT MIN(r2.car_num) FROM results r2 WHERE r2.race_id = r.race_id))
            ORDER BY r.race_id, r.finish_pos`,
      args: [raceIds],
    }),
    db.execute({
      sql: `SELECT race_id, bet_type, combination, odds_value, ninki FROM odds
            WHERE race_id = ANY(?::int[]) AND bet_type = '3連単'`,
      args: [raceIds],
    }),
    // lib/repository.ts getGirlsRaceIds と同じ判定（L級が1人でもいればガールズ）
    db.execute({
      sql: `SELECT DISTINCT e.race_id FROM entries e JOIN racers rc ON rc.snum = e.snum
            WHERE e.race_id = ANY(?::int[]) AND rc.class_rank LIKE 'L%'`,
      args: [raceIds],
    }),
  ]);
  const races = new Map(
    (racesRes.rows as unknown as Pick<RaceRow, "id" | "kaisai_date" | "keirinjo_name" | "race_no">[]).map((r) => [r.id, r])
  );
  const predictions = groupByRace(predictionsRes.rows as unknown as (PredictionRow & { race_id: number })[]);
  const results = groupByRace(resultsRes.rows as unknown as (ResultRow & { race_id: number })[]);
  const odds = groupByRace(oddsRes.rows as unknown as (OddsRow & { race_id: number })[]);
  const girls = new Set((girlsRes.rows as unknown as { race_id: number }[]).map((r) => r.race_id));

  const summaries: RaceResultSummary[] = [];
  for (const raceId of raceIds) {
    const race = races.get(raceId);
    if (!race) continue;
    summaries.push(
      computeRaceSummary(
        // computeRaceSummaryはraceを素通しするだけ。表示用に変換してから外へ返す（toHistoryRace）
        race as RaceRow,
        predictions.get(raceId) ?? [],
        results.get(raceId) ?? [],
        odds.get(raceId) ?? [],
        girls.has(raceId)
      )
    );
  }
  return summaries;
}

export interface HistoryRaceSummary {
  raceId: number;
  kaisaiDate: string;
  keirinjoName: string;
  raceNo: number;
  isGirlsRace: boolean;
  honmeiHit: boolean | null;
  honmeiTop3: boolean | null;
  sanrentanHit: boolean | null;
  roi: number | null;
}

function toHistoryRace(s: RaceResultSummary): HistoryRaceSummary {
  return {
    raceId: s.race.id,
    kaisaiDate: s.race.kaisai_date,
    keirinjoName: s.race.keirinjo_name,
    raceNo: s.race.race_no,
    isGirlsRace: s.isGirlsRace,
    honmeiHit: s.honmeiHit,
    honmeiTop3: s.honmeiTop3,
    sanrentanHit: s.sanrentanHit,
    roi: s.roi,
  };
}

export interface HistoryOverview {
  /** 予想を記録した直近300レース（新しい順）。 */
  recent: HistoryRaceSummary[];
  /** 予想・結果がそろった直近300レースの成績（ガールズ除く / ガールズのみ）。 */
  stats: AccuracyStats;
  girlsStats: AccuracyStats;
}

/** lib/accuracy.ts getOverallAccuracyStats・getGirlsAccuracyStats と予想一覧をまとめて1回の取得で作る。 */
export const getHistoryOverview = cachedQuery(
  "history.overview",
  async (): Promise<HistoryOverview> => {
    const [withPrediction, withResult] = await Promise.all([
      getRaceIdsWithPrediction(),
      getRaceIdsWithPredictionAndResult(),
    ]);
    const summaries = await getRaceSummaries([...new Set([...withPrediction, ...withResult])]);
    const byId = new Map(summaries.map((s) => [s.race.id, s]));
    const pick = (ids: number[]) => ids.flatMap((id) => byId.get(id) ?? []);
    const resolved = pick(withResult);
    return {
      recent: pick(withPrediction).map(toHistoryRace),
      stats: aggregateAccuracyStats(resolved.filter((s) => !s.isGirlsRace)),
      girlsStats: aggregateAccuracyStats(resolved.filter((s) => s.isGirlsRace)),
    };
  },
  [PICKS, RESULTS, RACES]
);

export interface HistoryDailySummary extends AccuracyStats {
  topPayouts: { raceId: number; keirinjoName: string; raceNo: number; combo: string; payoutYen: number }[];
}

function toHistoryDaily(d: DailySummary): HistoryDailySummary {
  return {
    totalRaces: d.totalRaces,
    honmeiHitRate: d.honmeiHitRate,
    honmeiTop3Rate: d.honmeiTop3Rate,
    sanrentanHitRate: d.sanrentanHitRate,
    overallRoi: d.overallRoi,
    topPayouts: d.topPayouts.map((p) => ({
      raceId: p.race.id,
      keirinjoName: p.race.keirinjo_name,
      raceNo: p.race.race_no,
      combo: p.combo,
      payoutYen: p.payoutYen,
    })),
  };
}

export interface HistoryDay {
  daily: HistoryDailySummary;
  girlsDaily: HistoryDailySummary;
  pickResults: DailyPickResult[];
  barikataResults: BarikataPickResult[];
}

/** 指定日のサマリー（lib/accuracy.ts getDailySummary・getGirlsDailySummary を1回の取得で）と厳選・バリカタの結果。 */
export const getHistoryDay = cachedQuery(
  "history.day",
  async (viewDate: string): Promise<HistoryDay> => {
    const idsRes = await getDb().execute({
      sql: "SELECT id FROM races WHERE kaisai_date = ? ORDER BY keirinjo_name ASC, race_no ASC",
      args: [viewDate],
    });
    const raceIds = (idsRes.rows as unknown as { id: number }[]).map((r) => r.id);
    const [summaries, pickResults, barikataResults] = await Promise.all([
      getRaceSummaries(raceIds),
      getDailyPicksResults(viewDate),
      getBarikataPicksResults(viewDate),
    ]);
    // 予想・結果の両方がそろったレースだけを数える（getDailySummaryと同じ）
    const resolved = summaries.filter((s) => s.honmeiHit != null);
    return {
      daily: toHistoryDaily(buildDailySummary(viewDate, resolved.filter((s) => !s.isGirlsRace))),
      girlsDaily: toHistoryDaily(buildDailySummary(viewDate, resolved.filter((s) => s.isGirlsRace))),
      pickResults,
      barikataResults,
    };
  },
  [PICKS, RESULTS, RACES]
);

export interface PickHitDay {
  date: string;
  hits: number;
  total: number;
}

/**
 * lib/repository.ts getCombinedPickHitHistory と同じ集計（日ごとの厳選+バリカタ合算の的中数）。
 * 旧版は日付ごとに直列で getDailyPicksResults・getBarikataPicksResults を呼んでいた
 * （14日で約80クエリ）ため、日付をまとめて4クエリにしている。各ピックの判定は
 * getDailyPicksResults（formationに実際の並びが含まれるか）・getBarikataPicksResults
 * （comboが実際の並びと一致するか）と同じ。
 */
export const getCombinedPickHitHistory = cachedQuery(
  "history.combinedPickHits",
  async (dates: string[]): Promise<PickHitDay[]> => {
    if (dates.length === 0) return [];
    const db = getDb();
    const [dailyRes, barikataRes] = await Promise.all([
      // getDailyPicks（日ごとにmargin上位10件）と同じ抽出
      db.execute({
        sql: `SELECT race_id, kaisai_date, formation FROM (
                SELECT race_id, kaisai_date, formation,
                       ROW_NUMBER() OVER (PARTITION BY kaisai_date ORDER BY margin DESC) AS rn
                FROM daily_picks WHERE kaisai_date = ANY(?::text[]) AND margin >= ? AND margin < ?
              ) t WHERE rn <= 10`,
        args: [dates, DAILY_PICKS_MIN_MARGIN, DAILY_PICKS_MAX_MARGIN],
      }),
      // getBarikataPicks（日ごとにmargin上位100件）と同じ抽出
      db.execute({
        sql: `SELECT race_id, kaisai_date, combo FROM (
                SELECT race_id, kaisai_date, combo,
                       ROW_NUMBER() OVER (PARTITION BY kaisai_date ORDER BY margin DESC) AS rn
                FROM barikata_picks WHERE kaisai_date = ANY(?::text[])
              ) t WHERE rn <= 100`,
        args: [dates],
      }),
    ]);
    const daily = dailyRes.rows as unknown as { race_id: number; kaisai_date: string; formation: string | null }[];
    const barikata = barikataRes.rows as unknown as { race_id: number; kaisai_date: string; combo: string }[];
    const raceIds = [...new Set([...daily, ...barikata].map((p) => p.race_id))];
    const [resultsMap, oddsMap] = await Promise.all([getResultsForRaces(raceIds), getOddsForRaces(raceIds)]);
    const actualComboOf = (raceId: number) =>
      resolveActualCombo(resultsMap.get(raceId) ?? [], oddsMap.get(raceId) ?? []);

    const byDate = new Map(dates.map((date) => [date, { date, hits: 0, total: 0 }]));
    for (const p of daily) {
      const actual = actualComboOf(p.race_id);
      if (actual == null || !p.formation) continue;
      const day = byDate.get(p.kaisai_date)!;
      day.total++;
      if ((JSON.parse(p.formation) as string[]).includes(actual)) day.hits++;
    }
    for (const p of barikata) {
      const actual = actualComboOf(p.race_id);
      if (actual == null) continue;
      const day = byDate.get(p.kaisai_date)!;
      day.total++;
      if (p.combo === actual) day.hits++;
    }
    return dates.map((date) => byDate.get(date)!);
  },
  [PICKS, RESULTS]
);
