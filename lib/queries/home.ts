/**
 * ホーム（/・/day/[date]）・/picks・開催場（/venues, /venues/[jocd]）・/favorites 画面の
 * DB読み取り。すべて lib/cache.ts の cachedQuery でタグ付きキャッシュに載せる
 * （これらの画面はISRでCDNから配信し、データが変わった時だけタグ失効で作り直すため、
 * 画面が読むDBはすべてタグ付きである必要がある）。
 *
 * 以前はレースID単位の取得を何度も繰り返していた（ホームは厳選・バリカタ・候補漏れ・
 * 中穴候補ごとに着順と払戻を取り直し、/picksは直近30日を1日ずつ×2種類で約180クエリ）。
 * ここでは開催日単位・期間単位にまとめて取り、的中判定はlib/repository.tsの
 * get*Results系と同じ計算をメモリ上で行う。
 */
import { CACHE_TAGS, cachedQuery, cachedPredictRace } from "../cache";
import { getDb } from "../db";
import { addDaysToDateStr } from "../date";
import { isSenkoIsshaRace } from "../scoring";
import {
  DAILY_PICKS_MAX_MARGIN,
  DAILY_PICKS_MIN_MARGIN,
  getAllBankInfo,
  getBankInfo,
  getBarikataNearMisses,
  getBarikataPicks,
  getDailyPicks,
  getFavoriteRacerEntriesForDate,
  getFavoriteRacers,
  getLastSyncedAt,
  getNakaanaPicks,
  getOddsForRaces,
  getRacesByDate,
  getRacesForEvent,
  getResultsForRaces,
  getScoreWeights,
  getVenueKimariteRank,
  getVenueKimariteRatesWithFallback,
  resolveActualCombo,
} from "../repository";
import {
  parseRaceSnapshotRow,
  sameWeights,
  snapshotFromPrediction,
  type RaceSnapshot,
  type RaceSnapshotDbRow,
} from "../race-snapshot";
import type {
  BarikataPickResult,
  BarikataPickRow,
  BarikataPicksPerformance,
  DailyPickResult,
  DailyPickRow,
  DailyPicksPerformance,
  OddsRow,
  ResultRow,
} from "../types";

const { races: RACES, results: RESULTS, picks: PICKS, settings: SETTINGS, favorites: FAVORITES } = CACHE_TAGS;

// ---- 開催日単位 ----

export const getRacesByDateCached = cachedQuery("q:racesByDate", getRacesByDate, [RACES]);
export const getLastSyncedAtCached = cachedQuery("q:lastSyncedAt", getLastSyncedAt, [RACES]);

export interface DayOutcomes {
  results: (ResultRow & { race_id: number })[];
  odds: (OddsRow & { race_id: number })[];
}

/**
 * 指定日の全レースの着順と3連単払戻。getResultsForRaces/getOddsForRacesと同じ列・並び
 * （着順はrace_id,finish_pos順）を、レースIDの列挙ではなく開催日で絞って1クエリずつ取る。
 */
async function fetchDayOutcomes(kaisaiDate: string): Promise<DayOutcomes> {
  const db = getDb();
  const [results, odds] = await Promise.all([
    db.execute({
      sql: `SELECT r.race_id, r.car_num, r.snum, r.finish_pos, r.kimarite
            FROM results r JOIN races ra ON ra.id = r.race_id
            WHERE ra.kaisai_date = ?
            ORDER BY r.race_id, r.finish_pos`,
      args: [kaisaiDate],
    }),
    db.execute({
      sql: `SELECT o.race_id, o.bet_type, o.combination, o.odds_value, o.ninki
            FROM odds o JOIN races ra ON ra.id = o.race_id
            WHERE ra.kaisai_date = ? AND o.bet_type = '3連単'`,
      args: [kaisaiDate],
    }),
  ]);
  return {
    results: results.rows as unknown as DayOutcomes["results"],
    odds: odds.rows as unknown as DayOutcomes["odds"],
  };
}
export const getDayOutcomes = cachedQuery("q:dayOutcomes", fetchDayOutcomes, [RACES, RESULTS]);

/** 「先行1車」タグ（lib/scoring.tsのisSenkoIsshaRace）が付く指定日のレースID。 */
async function fetchSenkoIsshaRaceIds(kaisaiDate: string): Promise<number[]> {
  const result = await getDb().execute({
    sql: `SELECT e.race_id, e.line_group FROM entries e JOIN races ra ON ra.id = e.race_id
          WHERE ra.kaisai_date = ?`,
    args: [kaisaiDate],
  });
  const byRace = new Map<number, (number | null)[]>();
  for (const r of result.rows as unknown as { race_id: number; line_group: number | null }[]) {
    const arr = byRace.get(r.race_id) ?? [];
    arr.push(r.line_group);
    byRace.set(r.race_id, arr);
  }
  return [...byRace].filter(([, groups]) => groups.length > 0 && isSenkoIsshaRace(groups)).map(([id]) => id);
}
export const getSenkoIsshaRaceIds = cachedQuery("q:senkoIsshaRaceIds", fetchSenkoIsshaRaceIds, [RACES]);

/**
 * 指定日の厳選（上位10件）・バリカタ・候補漏れ・中穴候補（各get*Results系と同じ件数上限）。
 * ホームと/picksで同じキャッシュを共有する。
 */
async function fetchDayPicks(kaisaiDate: string) {
  const [daily, barikata, nearMisses, nakaana] = await Promise.all([
    getDailyPicks(kaisaiDate),
    getBarikataPicks(kaisaiDate),
    getBarikataNearMisses(kaisaiDate),
    getNakaanaPicks(kaisaiDate),
  ]);
  return { daily, barikata, nearMisses, nakaana };
}
export const getDayPicks = cachedQuery("q:dayPicks", fetchDayPicks, [PICKS]);

// ---- 的中判定（lib/repository.tsのget*Results系と同じ計算） ----

interface PickOutcome {
  finished: boolean;
  hit: boolean | null;
  stakeYen: number | null;
  payoutYen: number | null;
}

function payoutFor(hit: boolean, actualCombo: string, odds: OddsRow[]): number {
  const hitOdds = odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
  return hit && hitOdds != null ? 100 * hitOdds : 0;
}

/** フォーメーション買い（厳選・中穴候補）。getDailyPicksResults/getNakaanaPicksResultsと同じ。 */
export function evaluateFormationPick<P extends { formation: string[] | null }>(
  pick: P,
  results: ResultRow[],
  odds: OddsRow[]
): { pick: P } & PickOutcome {
  const actualCombo = resolveActualCombo(results, odds);
  if (actualCombo == null || pick.formation == null) {
    return { pick, finished: false, hit: null, stakeYen: null, payoutYen: null };
  }
  const hit = pick.formation.includes(actualCombo);
  return { pick, finished: true, hit, stakeYen: 100 * pick.formation.length, payoutYen: payoutFor(hit, actualCombo, odds) };
}

/** 1点買い（バリカタ・候補漏れ）。getBarikataPicksResults/getBarikataNearMissesResultsと同じ。 */
export function evaluateComboPick<P extends { combo: string }>(
  pick: P,
  results: ResultRow[],
  odds: OddsRow[]
): { pick: P } & PickOutcome {
  const actualCombo = resolveActualCombo(results, odds);
  if (actualCombo == null) {
    return { pick, finished: false, hit: null, stakeYen: null, payoutYen: null };
  }
  const hit = pick.combo === actualCombo;
  return { pick, finished: true, hit, stakeYen: 100, payoutYen: payoutFor(hit, actualCombo, odds) };
}

export function groupByRaceId<T extends { race_id: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const arr = map.get(row.race_id) ?? [];
    arr.push(row);
    map.set(row.race_id, arr);
  }
  return map;
}

// ---- /picks：前日の結果・直近N日の実績 ----

export interface PicksHistory {
  prevResults: DailyPickResult[];
  barikataPrevResults: BarikataPickResult[];
  performance: DailyPicksPerformance;
  barikataPerformance: BarikataPicksPerformance;
}

/**
 * viewDateの前日からwindowDays日分の厳選・バリカタの的中実績。getDailyPicksPerformance/
 * getBarikataPicksPerformance（1日ずつ getDaily/BarikataPicks + 着順 + 払戻）と同じ対象・
 * 同じ集計順（新しい日付から、各日margin降順）で、期間まとめて数クエリで取る。
 * 各日の件数上限（厳選10件・バリカタ100件）はROW_NUMBERで同じく日ごとにかける。
 */
async function fetchPicksHistory(viewDate: string, windowDays: number): Promise<PicksHistory> {
  const dates = Array.from({ length: windowDays }, (_, i) => addDaysToDateStr(viewDate, -1 - i));
  const prevDate = dates[0];
  const from = dates[dates.length - 1];
  const db = getDb();
  const [dailyResult, barikataResult] = await Promise.all([
    db.execute({
      sql: `SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin,
                   honmei_car_num, honmei_name, formation
            FROM (SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin,
                         honmei_car_num, honmei_name, formation,
                         ROW_NUMBER() OVER (PARTITION BY kaisai_date ORDER BY margin DESC) AS rn
                  FROM daily_picks
                  WHERE kaisai_date >= ? AND kaisai_date <= ? AND margin >= ? AND margin < ?) t
            WHERE rn <= 10
            ORDER BY kaisai_date, margin DESC`,
      args: [from, prevDate, DAILY_PICKS_MIN_MARGIN, DAILY_PICKS_MAX_MARGIN],
    }),
    db.execute({
      sql: `SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin, combo,
                   honmei_car_num, honmei_name
            FROM (SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin, combo,
                         honmei_car_num, honmei_name,
                         ROW_NUMBER() OVER (PARTITION BY kaisai_date ORDER BY margin DESC) AS rn
                  FROM barikata_picks
                  WHERE kaisai_date >= ? AND kaisai_date <= ?) t
            WHERE rn <= 100
            ORDER BY kaisai_date, margin DESC`,
      args: [from, prevDate],
    }),
  ]);
  const dailyPicks = (
    dailyResult.rows as unknown as (Omit<DailyPickRow, "formation"> & { formation: string | null })[]
  ).map((r) => ({ ...r, formation: r.formation ? (JSON.parse(r.formation) as string[]) : null }));
  const barikataPicks = barikataResult.rows as unknown as BarikataPickRow[];

  const raceIds = [...new Set([...dailyPicks, ...barikataPicks].map((p) => p.race_id))];
  const [resultsMap, oddsMap] = await Promise.all([getResultsForRaces(raceIds), getOddsForRaces(raceIds)]);

  const byDate = <T extends { kaisai_date: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const arr = map.get(r.kaisai_date) ?? [];
      arr.push(r);
      map.set(r.kaisai_date, arr);
    }
    return map;
  };
  const summarize = <R extends PickOutcome>(perDate: Map<string, R[]>) => {
    let races = 0;
    let hits = 0;
    let stakeYen = 0;
    let payoutYen = 0;
    for (const date of dates) {
      for (const r of perDate.get(date) ?? []) {
        if (!r.finished) continue;
        races++;
        if (r.hit) hits++;
        stakeYen += r.stakeYen ?? 0;
        payoutYen += r.payoutYen ?? 0;
      }
    }
    return { days: dates.length, races, hits, stakeYen, payoutYen, roi: stakeYen > 0 ? (payoutYen / stakeYen) * 100 : null };
  };

  const dailyByDate = new Map(
    [...byDate(dailyPicks)].map(([d, picks]) => [
      d,
      picks.map((p) => evaluateFormationPick(p, resultsMap.get(p.race_id) ?? [], oddsMap.get(p.race_id) ?? [])),
    ])
  );
  const barikataByDate = new Map(
    [...byDate(barikataPicks)].map(([d, picks]) => [
      d,
      picks.map((p) => evaluateComboPick(p, resultsMap.get(p.race_id) ?? [], oddsMap.get(p.race_id) ?? [])),
    ])
  );

  return {
    prevResults: dailyByDate.get(prevDate) ?? [],
    barikataPrevResults: barikataByDate.get(prevDate) ?? [],
    performance: summarize(dailyByDate),
    barikataPerformance: summarize(barikataByDate),
  };
}
export const getPicksHistory = cachedQuery("q:picksHistory", fetchPicksHistory, [PICKS, RESULTS]);

// ---- 予想スナップショット（lib/race-snapshot.ts） ----

export const getScoreWeightsCached = cachedQuery("q:scoreWeights", getScoreWeights, [SETTINGS]);

async function fetchRaceSnapshotRows(raceIds: number[]): Promise<RaceSnapshotDbRow[]> {
  if (raceIds.length === 0) return [];
  try {
    const result = await getDb().execute({
      sql: `SELECT race_id, margin, top_entries, scenarios, honmei_reason, weights
            FROM race_snapshots WHERE race_id IN (${raceIds.map(() => "?").join(",")})`,
      args: raceIds,
    });
    return result.rows as unknown as RaceSnapshotDbRow[];
  } catch (err) {
    // マイグレーション（scripts/migrate-race-snapshots.ts）前はテーブルが無い。
    // 空として扱い、呼び出し側のpredictRaceへのフォールバックで従来どおり表示する。
    const e = err as { code?: string; message?: string };
    if (e.code === "42P01" || /no such table/i.test(e.message ?? "")) return [];
    throw err;
  }
}
// compute-picksが書くテーブルなので、厳選等と同じpicksタグで失効させる。
const getRaceSnapshotRows = cachedQuery("q:raceSnapshotRows", fetchRaceSnapshotRows, [PICKS]);

/**
 * レースごとの予想スナップショット（予想が作れないレースはnull）。保存済みの行を使い、
 * 行が無い（マイグレーション前・発走後に追加されたレース等）か、保存後に設定画面で
 * 重みが変わった場合だけ predictRace から同じ形を作る（以前のように毎回predictRaceを
 * 実行していた時と同じ値を表示するため）。
 */
export async function getRaceSnapshots(raceIds: number[]): Promise<Map<number, RaceSnapshot | null>> {
  const ids = [...new Set(raceIds)].sort((a, b) => a - b);
  const out = new Map<number, RaceSnapshot | null>();
  if (ids.length === 0) return out;
  const [rows, weights] = await Promise.all([getRaceSnapshotRows(ids), getScoreWeightsCached()]);
  const stored = new Map(rows.map((r) => [r.race_id, parseRaceSnapshotRow(r)]));
  const missing: number[] = [];
  for (const id of ids) {
    const snapshot = stored.get(id);
    if (snapshot && sameWeights(snapshot.weights, weights)) out.set(id, snapshot);
    else missing.push(id);
  }
  const live = await Promise.all(missing.map((id) => cachedPredictRace(id)));
  missing.forEach((id, i) => {
    const prediction = live[i];
    out.set(id, prediction ? snapshotFromPrediction(id, prediction, weights) : null);
  });
  return out;
}

// ---- お気に入り ----

export const getFavoriteEntriesForDate = cachedQuery(
  "q:favoriteEntriesForDate",
  getFavoriteRacerEntriesForDate,
  [FAVORITES, RACES, RESULTS]
);
export const getFavoriteRacersCached = cachedQuery("q:favoriteRacers", getFavoriteRacers, [FAVORITES, RACES]);

// ---- 開催場 ----

export const getRacesForEventCached = cachedQuery("q:racesForEvent", getRacesForEvent, [RACES]);
export const getVenueKimariteRatesCached = cachedQuery(
  "q:venueKimariteRates",
  (jocd: string) => getVenueKimariteRatesWithFallback(jocd),
  [RACES, RESULTS]
);
export const getVenueKimariteRankCached = cachedQuery(
  "q:venueKimariteRank",
  (jocd: string) => getVenueKimariteRank(jocd),
  [RACES, RESULTS]
);
// キャッシュはJSONで保存するためundefinedをそのまま返さない（読み戻しで壊れる）。
export const getBankInfoCached = cachedQuery("q:bankInfo", async (jocd: string) => (await getBankInfo(jocd)) ?? null, [
  RACES,
]);
export const getAllBankInfoCached = cachedQuery("q:allBankInfo", getAllBankInfo, [RACES]);
