/**
 * 取得経路の最適化（2026-10、scripts/research/verify-fetch-optimization.ts）より前の
 * predictRace / savePrediction をそのまま凍結した比較用コピー。
 *
 * 変更前は選手ごと・種類ごとに1クエリずつ（1レース約30往復）、2・3着モデル用履歴は
 * 全履歴、単騎時勝率・ガールズ上がり能力も（加減点0で結果に効かないのに）毎回取得していた。
 * 新しい経路（lib/predict.ts・lib/repository.ts）と出力が1バイトも違わないことを
 * 確かめるためだけに使う。SQLは変更前の文字列のまま、読取キャッシュも使わない。
 * 本番コードからは参照しないこと。
 */
import { getDb } from "../../../lib/db";
import {
  computeForm,
  pairProbabilities,
  posCatOf,
  PIT_MEN_COEFS,
  PIT_PRIORS,
  PIT_SHRINKAGE_K,
  type PairProb,
  type PitRecord,
} from "../../../lib/second-third-model";
import { scoreRace, generateBetSuggestions, generateScenarios, HIGH_CONFIDENCE_MARGIN } from "../../../lib/scoring";
import type { RacePrediction } from "../../../lib/predict";
import type {
  BankInfoRow,
  EntryWithRacer,
  GirlsAgariAbility,
  PositionWinRate,
  RaceRow,
  RacerHistoryRow,
  ScoredEntry,
  ScoreWeights,
  SoloWinRate,
  VenueKimariteRates,
} from "../../../lib/types";

const q = async <T>(sql: string, args: unknown[] = []) => (await getDb().execute({ sql, args })).rows as unknown as T[];

async function legacyGetRace(raceId: number) {
  return (await q<RaceRow>("SELECT * FROM races WHERE id = ?", [raceId]))[0];
}

async function legacyGetEntriesForRace(raceId: number) {
  return q<EntryWithRacer>(
    `SELECT e.id as entry_id, e.race_id, e.car_num, e.line_group, e.line_position,
                 e.pre_race_comment, e.gear_ratio as race_gear_ratio,
                 r.snum, r.name, COALESCE(e.pref, r.pref) as pref, r.class_rank, r.prev_class_rank, r.kyakushitsu, r.gear_ratio,
                 r.heikin_tokuten, r.syouritu, r.rentairitu2, r.rentairitu3,
                 r.kimarite_nige_count, r.kimarite_makuri_count,
                 r.kimarite_sashi_count, r.kimarite_mark_count,
                 r.standing_count, r.home_lead_count, r.back_lead_count,
                 r.debut_class, r.tt200_sec, r.tt400_sec, r.tt500_sec, r.tt2000_sec,
                 r.tt1000_sec, r.tt3000_sec, r.kisokukai_grade
          FROM entries e
          JOIN racers r ON e.snum = r.snum
          WHERE e.race_id = ?
          ORDER BY e.car_num`,
    [raceId]
  );
}

async function legacyGetScoreWeights(): Promise<ScoreWeights> {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'score_weight_%'");
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    line: map["score_weight_line"] ?? 0.35,
    kyakushitsu: map["score_weight_kyakushitsu"] ?? 0.35,
    stats: map["score_weight_stats"] ?? 0.3,
  };
}

async function legacyGetBankInfo(jocd: string) {
  return (await q<BankInfoRow>("SELECT * FROM bank_info WHERE jocd = ?", [jocd]))[0];
}

function kimariteFromRows(rows: { kimarite: string; c: number }[]): VenueKimariteRates {
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  const pct = (k: string) => ((rows.find((r) => r.kimarite === k)?.c ?? 0) / total) * 100;
  return { nige_pct: pct("逃"), makuri_pct: pct("捲"), sashi_pct: pct("差"), races: total };
}

async function legacyGetVenueKimariteRatesWithFallback(jocd: string, beforeDate: string) {
  const venueRows = await q<{ kimarite: string; c: number }>(
    `SELECT r.kimarite, COUNT(*) as c
          FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE ra.jocd = ? AND r.finish_pos = 1 AND r.kimarite IS NOT NULL AND ra.kaisai_date < ?
          GROUP BY r.kimarite`,
    [jocd, beforeDate]
  );
  if (venueRows.reduce((s, r) => s + r.c, 0) >= 40) return kimariteFromRows(venueRows);
  const perLap = (
    await q<{ perLap: number | null }>(
      `SELECT AVG(kyori * 1.0 / shukai) as perLap FROM races
          WHERE jocd = ? AND kyori IS NOT NULL AND shukai IS NOT NULL AND shukai > 0`,
      [jocd]
    )
  )[0]?.perLap;
  if (perLap == null) return null;
  let bankLength: number | null = null;
  let bestDiff = Infinity;
  for (const c of [333, 400, 500]) {
    const diff = Math.abs(perLap - c);
    if (diff < bestDiff && diff <= 20) {
      bestDiff = diff;
      bankLength = c;
    }
  }
  if (bankLength == null) return null;
  const venues = await q<{ jocd: string; perLap: number }>(`
    SELECT jocd, AVG(kyori * 1.0 / shukai) as perLap
    FROM races
    WHERE kyori IS NOT NULL AND shukai IS NOT NULL AND shukai > 0
    GROUP BY jocd
  `);
  const jocds = venues.filter((r) => Math.abs(r.perLap - bankLength) <= 20).map((r) => r.jocd);
  if (jocds.length === 0) return null;
  const rows = await q<{ kimarite: string; c: number }>(
    `SELECT r.kimarite, COUNT(*) as c
          FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE ra.jocd IN (${jocds.map(() => "?").join(",")})
            AND r.finish_pos = 1 AND r.kimarite IS NOT NULL AND ra.kaisai_date < ?
          GROUP BY r.kimarite`,
    [...jocds, beforeDate]
  );
  if (rows.reduce((s, r) => s + r.c, 0) < 100) return null;
  return kimariteFromRows(rows);
}

async function legacyGetRacerHistory(snum: string, beforeDate: string) {
  return q<RacerHistoryRow>(
    `SELECT race_date, venue_abbr, finish_positions FROM racer_race_history
          WHERE snum = ? AND race_date_full IS NOT NULL AND race_date_full < ?
          ORDER BY race_date_full DESC NULLS LAST, race_date DESC`,
    [snum, beforeDate]
  );
}

async function legacyGetPositionWinRates(snum: string, beforeDate: string): Promise<PositionWinRate[]> {
  const rows = await q<{ line_position: string; races: number; wins: number; seconds: number; thirds: number }>(
    `SELECT e.line_position,
                 COUNT(*) as races,
                 SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins,
                 SUM(CASE WHEN r.finish_pos = 2 THEN 1 ELSE 0 END) as seconds,
                 SUM(CASE WHEN r.finish_pos = 3 THEN 1 ELSE 0 END) as thirds
          FROM entries e
          JOIN results r ON r.race_id = e.race_id AND r.snum = e.snum
          JOIN races ra ON ra.id = e.race_id
          WHERE e.snum = ? AND e.line_position IS NOT NULL AND ra.kaisai_date < ?
          GROUP BY e.line_position`,
    [snum, beforeDate]
  );
  return rows.map((r) => ({
    line_position: r.line_position,
    races: r.races,
    wins: r.wins,
    winRate: r.races > 0 ? (r.wins / r.races) * 100 : 0,
    seconds: r.seconds,
    secondRate: r.races > 0 ? (r.seconds / r.races) * 100 : 0,
    thirds: r.thirds,
    thirdRate: r.races > 0 ? (r.thirds / r.races) * 100 : 0,
  }));
}

async function legacyGetSoloWinRate(snum: string, beforeDate: string): Promise<SoloWinRate | null> {
  const row = (
    await q<{ races: number; wins: number }>(
      `SELECT COUNT(*) as races, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
          FROM entries e
          JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
          JOIN races ra ON ra.id = e.race_id
          WHERE e.snum = ? AND e.line_group IS NOT NULL AND ra.kaisai_date < ?
            AND (SELECT COUNT(*) FROM entries e2
                 WHERE e2.race_id = e.race_id AND e2.line_group = e.line_group) = 1`,
      [snum, beforeDate]
    )
  )[0];
  if (!row || row.races === 0) return null;
  return { races: row.races, wins: row.wins, winRate: (row.wins / row.races) * 100 };
}

async function legacyGetGirlsAgariAbility(snum: string, beforeDate: string): Promise<GirlsAgariAbility | null> {
  const row = (
    await q<{ avg_rank_pct: number | null; races: number }>(
      `WITH race_agari AS (
            SELECT r.race_id, r.snum, r.agari_time,
                   COUNT(*) OVER (PARTITION BY r.race_id) AS field_size,
                   RANK() OVER (PARTITION BY r.race_id ORDER BY r.agari_time ASC) AS speed_rank
            FROM results r
            JOIN races ra ON ra.id = r.race_id
            WHERE r.agari_time IS NOT NULL AND ra.kaisai_date < ?
          )
          SELECT AVG((field_size - speed_rank)::float / NULLIF(field_size - 1, 0)) AS avg_rank_pct,
                 COUNT(*) AS races
          FROM race_agari
          WHERE snum = ? AND field_size >= 2`,
      [beforeDate, snum]
    )
  )[0];
  if (!row || row.races === 0 || row.avg_rank_pct == null) return null;
  return { avgRankPct: row.avg_rank_pct, races: row.races };
}

/** 変更前の getPitHistories（全履歴を返す）。 */
export async function legacyGetPitHistories(snums: string[], beforeDate: string): Promise<Map<string, PitRecord[]>> {
  const out = new Map<string, PitRecord[]>(snums.map((s) => [s, []]));
  if (snums.length === 0) return out;
  const rows = await q<{
    snum: string;
    kaisai_date: string;
    finish_pos: number;
    kimarite: string | null;
    line_position: string | null;
    line_group: number | null;
    field_size: number;
    line_size: number | null;
  }>(
    `SELECT res.snum AS snum, ra.kaisai_date AS kaisai_date, res.finish_pos AS finish_pos,
                 res.kimarite AS kimarite, e.line_position AS line_position, e.line_group AS line_group,
                 (SELECT COUNT(*) FROM results r2 WHERE r2.race_id = res.race_id) AS field_size,
                 (SELECT COUNT(*) FROM entries e2
                   WHERE e2.race_id = e.race_id AND e2.line_group = e.line_group) AS line_size
          FROM results res
          JOIN races ra ON ra.id = res.race_id
          LEFT JOIN entries e ON e.race_id = res.race_id AND e.car_num = res.car_num
          WHERE res.snum IN (${snums.map(() => "?").join(",")})
            AND ra.kaisai_date < ? AND res.finish_pos IS NOT NULL`,
    [...snums, beforeDate]
  );
  for (const row of rows) {
    const hasEntry = row.line_position != null || row.line_group != null;
    out.get(row.snum)?.push({
      date: row.kaisai_date,
      finishPos: row.finish_pos,
      fieldSize: row.field_size,
      posCat: hasEntry ? posCatOf(row.line_position, row.line_group, row.line_size ?? 1) : null,
      kimarite: row.kimarite,
    });
  }
  return out;
}

/** 変更前の predictRace 本体（取得の順序・内容とも当時のまま）。 */
export async function legacyPredictRace(raceId: number): Promise<RacePrediction | null> {
  const race = await legacyGetRace(raceId);
  if (!race) return null;
  const entries = await legacyGetEntriesForRace(raceId);
  const weights = await legacyGetScoreWeights();
  const bankInfo = await legacyGetBankInfo(race.jocd);
  const venueKimarite = await legacyGetVenueKimariteRatesWithFallback(race.jocd, race.kaisai_date);
  const historyBySnum = Object.fromEntries(
    await Promise.all(entries.map(async (e) => [e.snum, await legacyGetRacerHistory(e.snum, race.kaisai_date)] as const))
  );
  const positionWinRatesBySnum = Object.fromEntries(
    await Promise.all(entries.map(async (e) => [e.snum, await legacyGetPositionWinRates(e.snum, race.kaisai_date)] as const))
  );
  const soloWinRateBySnum = Object.fromEntries(
    await Promise.all(entries.map(async (e) => [e.snum, await legacyGetSoloWinRate(e.snum, race.kaisai_date)] as const))
  );
  const girlsAgariAbilityBySnum = Object.fromEntries(
    await Promise.all(
      entries
        .filter((e) => e.class_rank?.startsWith("L"))
        .map(async (e) => [e.snum, await legacyGetGirlsAgariAbility(e.snum, race.kaisai_date)] as const)
    )
  );
  const scored = scoreRace(
    entries,
    weights,
    race.kaisai_date,
    race.keirinjo_name,
    race.jocd,
    bankInfo,
    historyBySnum,
    positionWinRatesBySnum,
    venueKimarite,
    race.shukai,
    soloWinRateBySnum,
    girlsAgariAbilityBySnum
  );
  const isGirls = scored.some((s) => s.entry.class_rank?.startsWith("L"));
  let secondThird: PairProb[] | null = null;
  if (!isGirls && scored.length >= 3) {
    const histories = await legacyGetPitHistories(
      scored.map((s) => s.entry.snum),
      race.kaisai_date
    );
    const pitEntries = scored.map((s) => ({
      car: s.entry.car_num,
      lineGroup: s.entry.line_group,
      linePos: s.entry.line_position,
      form: computeForm(histories.get(s.entry.snum) ?? [], race.kaisai_date, PIT_PRIORS, PIT_SHRINKAGE_K),
    }));
    secondThird = pairProbabilities(pitEntries, scored[0].entry.car_num, PIT_MEN_COEFS, { girls: false });
  }
  const scenarios = generateScenarios(scored, venueKimarite ?? bankInfo, secondThird);
  const boxSuggestion = generateBetSuggestions(scored).find((s) => s.betType === "3連複ボックス");
  let winSuggestion: RacePrediction["winSuggestion"] = null;
  if (scored.length >= 2) {
    const margin = scored[0].totalScore - scored[1].totalScore;
    if (margin >= HIGH_CONFIDENCE_MARGIN) {
      winSuggestion = { carNum: scored[0].entry.car_num, name: scored[0].entry.name, margin };
    }
  }
  return { race, bankInfo, venueKimarite, scored, scenarios, boxSuggestion, winSuggestion, secondThird };
}

/** 変更前の savePrediction（1行1文のbatch）。転送量・往復数の比較計測用。 */
export async function legacySavePrediction(raceId: number, scored: ScoredEntry[], honmeiFormation?: string[]) {
  const sql = `INSERT INTO predictions (race_id, car_num, snum, mark, total_score,
                                         line_score, kyakushitsu_score, stats_score, formation)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(race_id, car_num) DO UPDATE SET
                 mark=excluded.mark, total_score=excluded.total_score,
                 line_score=excluded.line_score, kyakushitsu_score=excluded.kyakushitsu_score,
                 stats_score=excluded.stats_score, formation=excluded.formation,
                 predicted_at=datetime('now')`;
  await getDb().batch(
    scored.map((s, i) => ({
      sql,
      args: [
        raceId,
        s.entry.car_num,
        s.entry.snum,
        s.mark,
        s.totalScore,
        s.lineScore.score,
        s.kyakushitsuScore.score,
        s.statsScore.score,
        i === 0 && honmeiFormation ? JSON.stringify(honmeiFormation) : null,
      ],
    }))
  );
}
