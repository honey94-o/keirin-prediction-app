import { getDb } from "./db";
import type {
  BankInfoRow,
  EntryWithRacer,
  OddsRow,
  PositionWinRate,
  PredictionRow,
  RaceRow,
  RacerHistoryRow,
  RacerRow,
  ResultRow,
  ScoredEntry,
  ScoreWeights,
} from "./types";

export async function getRace(raceId: number): Promise<RaceRow | undefined> {
  const result = await getDb().execute({
    sql: "SELECT * FROM races WHERE id = ?",
    args: [raceId],
  });
  return result.rows[0] as unknown as RaceRow | undefined;
}

export async function getAllRaces(): Promise<RaceRow[]> {
  const result = await getDb().execute(
    `SELECT * FROM races ORDER BY kaisai_date DESC, keirinjo_name ASC, race_no ASC`
  );
  return result.rows as unknown as RaceRow[];
}

export async function getRacer(snum: string): Promise<RacerRow | undefined> {
  const result = await getDb().execute({
    sql: "SELECT * FROM racers WHERE snum = ?",
    args: [snum],
  });
  return result.rows[0] as unknown as RacerRow | undefined;
}

export async function getEntriesForRace(raceId: number): Promise<EntryWithRacer[]> {
  const result = await getDb().execute({
    sql: `SELECT e.id as entry_id, e.race_id, e.car_num, e.line_group, e.line_position,
                 r.snum, r.name, r.pref, r.class_rank, r.prev_class_rank, r.kyakushitsu, r.gear_ratio,
                 r.heikin_tokuten, r.syouritu, r.rentairitu2, r.rentairitu3
          FROM entries e
          JOIN racers r ON e.snum = r.snum
          WHERE e.race_id = ?
          ORDER BY e.car_num`,
    args: [raceId],
  });
  return result.rows as unknown as EntryWithRacer[];
}

export async function getOddsForRace(raceId: number): Promise<OddsRow[]> {
  const result = await getDb().execute({
    sql: "SELECT bet_type, combination, odds_value FROM odds WHERE race_id = ?",
    args: [raceId],
  });
  return result.rows as unknown as OddsRow[];
}

export async function getBankInfo(jocd: string): Promise<BankInfoRow | undefined> {
  const result = await getDb().execute({
    sql: "SELECT * FROM bank_info WHERE jocd = ?",
    args: [jocd],
  });
  return result.rows[0] as unknown as BankInfoRow | undefined;
}

export async function getRacerHistory(snum: string): Promise<RacerHistoryRow[]> {
  const result = await getDb().execute({
    sql: `SELECT race_date, venue_abbr, finish_positions FROM racer_race_history
          WHERE snum = ? ORDER BY race_date DESC`,
    args: [snum],
  });
  return result.rows as unknown as RacerHistoryRow[];
}

/**
 * 蓄積済みの entries.line_position × results.finish_pos から、
 * 選手ごとの隊列内位置別の勝率（1着になった割合）を算出する。
 * 公式サイトにこの統計は存在しないため、自前のスクレイピング履歴から集計する。
 * スクレイピング件数が少ないうちは母数が小さく参考程度にしかならない点に注意。
 */
export async function getPositionWinRates(snum: string): Promise<PositionWinRate[]> {
  const result = await getDb().execute({
    sql: `SELECT e.line_position,
                 COUNT(*) as races,
                 SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
          FROM entries e
          JOIN results r ON r.race_id = e.race_id AND r.snum = e.snum
          WHERE e.snum = ? AND e.line_position IS NOT NULL
          GROUP BY e.line_position`,
    args: [snum],
  });
  const rows = result.rows as unknown as { line_position: string; races: number; wins: number }[];

  return rows.map((r) => ({
    line_position: r.line_position,
    races: r.races,
    wins: r.wins,
    winRate: r.races > 0 ? (r.wins / r.races) * 100 : 0,
  }));
}

const DEFAULT_WEIGHTS: ScoreWeights = { line: 0.35, kyakushitsu: 0.35, stats: 0.3 };

export async function getScoreWeights(): Promise<ScoreWeights> {
  const result = await getDb().execute(
    "SELECT key, value FROM settings WHERE key LIKE 'score_weight_%'"
  );
  const rows = result.rows as unknown as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    line: map["score_weight_line"] ?? DEFAULT_WEIGHTS.line,
    kyakushitsu: map["score_weight_kyakushitsu"] ?? DEFAULT_WEIGHTS.kyakushitsu,
    stats: map["score_weight_stats"] ?? DEFAULT_WEIGHTS.stats,
  };
}

export async function setScoreWeights(weights: ScoreWeights): Promise<void> {
  const db = getDb();
  const sql = `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`;
  await db.batch([
    { sql, args: ["score_weight_line", String(weights.line)] },
    { sql, args: ["score_weight_kyakushitsu", String(weights.kyakushitsu)] },
    { sql, args: ["score_weight_stats", String(weights.stats)] },
  ]);
}

/** 発走前の予想（スコア・印）をスナップショットとして保存する。 */
export async function savePrediction(raceId: number, scored: ScoredEntry[]): Promise<void> {
  const db = getDb();
  const sql = `INSERT INTO predictions (race_id, car_num, snum, mark, total_score,
                                         line_score, kyakushitsu_score, stats_score)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(race_id, car_num) DO UPDATE SET
                 mark=excluded.mark, total_score=excluded.total_score,
                 line_score=excluded.line_score, kyakushitsu_score=excluded.kyakushitsu_score,
                 stats_score=excluded.stats_score, predicted_at=datetime('now')`;
  await db.batch(
    scored.map((s) => ({
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
      ],
    }))
  );
}

export async function getPredictionsForRace(raceId: number): Promise<PredictionRow[]> {
  const result = await getDb().execute({
    sql: `SELECT car_num, snum, mark, total_score, line_score, kyakushitsu_score, stats_score
          FROM predictions WHERE race_id = ? ORDER BY total_score DESC`,
    args: [raceId],
  });
  return result.rows as unknown as PredictionRow[];
}

export async function getResultsForRace(raceId: number): Promise<ResultRow[]> {
  const result = await getDb().execute({
    sql: "SELECT car_num, snum, finish_pos, kimarite FROM results WHERE race_id = ? ORDER BY finish_pos",
    args: [raceId],
  });
  return result.rows as unknown as ResultRow[];
}

/** 予想（predictions）と結果（results）の両方が揃っているレースIDの一覧。 */
export async function getRaceIdsWithPredictionAndResult(): Promise<number[]> {
  const result = await getDb().execute(
    `SELECT DISTINCT p.race_id
     FROM predictions p
     JOIN results r ON r.race_id = p.race_id
     ORDER BY p.race_id DESC`
  );
  return (result.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
}

/** 予想（predictions）を保存済みの全レースID（結果未確定のものも含む）。 */
export async function getRaceIdsWithPrediction(): Promise<number[]> {
  const result = await getDb().execute(
    `SELECT DISTINCT race_id FROM predictions ORDER BY race_id DESC`
  );
  return (result.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
}
