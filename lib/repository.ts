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
  ScenarioStatsRow,
  ScoredEntry,
  ScoreWeights,
  VenueKimariteRates,
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

/** 指定日（YYYYMMDD）のレース一覧。レース一覧画面（`/`）は当日分だけを表示するため。 */
export async function getRacesByDate(kaisaiDate: string): Promise<RaceRow[]> {
  const result = await getDb().execute({
    sql: `SELECT * FROM races WHERE kaisai_date = ? ORDER BY keirinjo_name ASC, race_no ASC`,
    args: [kaisaiDate],
  });
  return result.rows as unknown as RaceRow[];
}

/** 同じ開催（同日・同開催場）の他のレース一覧。レース切り替えタブ用。 */
export async function getRacesForEvent(kaisaiDate: string, jocd: string): Promise<RaceRow[]> {
  const result = await getDb().execute({
    sql: `SELECT * FROM races WHERE kaisai_date = ? AND jocd = ? ORDER BY race_no ASC`,
    args: [kaisaiDate, jocd],
  });
  return result.rows as unknown as RaceRow[];
}

export interface TodayVenues {
  names: string[];
  syncedDate: string | null; // YYYYMMDD。一度も同期されていなければnull
}

/**
 * 本日発売中の開催場名一覧（GitHub Actions側でキャッシュ済みのもの）を取得する。
 * synced_dateが今日でない場合は「古いキャッシュ」として扱えるよう日付も返す
 * （UI側で「本日分に更新してください」等の案内に使う）。
 */
export async function getTodayVenues(): Promise<TodayVenues> {
  const result = await getDb().execute(
    "SELECT venue_name, synced_date FROM today_venues ORDER BY venue_name"
  );
  const rows = result.rows as unknown as { venue_name: string; synced_date: string }[];
  return {
    names: rows.map((r) => r.venue_name),
    syncedDate: rows[0]?.synced_date ?? null,
  };
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
                 r.heikin_tokuten, r.syouritu, r.rentairitu2, r.rentairitu3,
                 r.kimarite_nige_count, r.kimarite_makuri_count,
                 r.kimarite_sashi_count, r.kimarite_mark_count
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

/**
 * 開催場ごとの決まり手（逃/捲/差）割合を、自前のresults実績から直接算出する。
 * bank_info（KEIRIN.JPのjyoguideスクレイプ）はほとんどの開催場で未取得のため、
 * 蓄積したバックテストデータの方が実際にはカバレッジが広い。
 * 母数がminRaces未満の開催場はサンプル不足として null を返す。
 *
 * minRaces=15で試したところ、母数が少ない開催場（20〜30件程度）の推定値が
 * ノイズで振れすぎて◎的中率・回収率とも悪化した（バックテスト済み）。
 * 40に上げると小規模開催場は素通し（ニュートラル値）になる一方、対象になった
 * 開催場では実際に◎的中率・回収率とも据え置き比で改善したため、この値を採用。
 */
export async function getVenueKimariteRates(
  jocd: string,
  minRaces = 40
): Promise<VenueKimariteRates | null> {
  const result = await getDb().execute({
    sql: `SELECT r.kimarite, COUNT(*) as c
          FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE ra.jocd = ? AND r.finish_pos = 1 AND r.kimarite IS NOT NULL
          GROUP BY r.kimarite`,
    args: [jocd],
  });
  const rows = result.rows as unknown as { kimarite: string; c: number }[];
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  if (total < minRaces) return null;

  return venueKimariteFromRows(rows);
}

function venueKimariteFromRows(
  rows: { kimarite: string; c: number }[]
): VenueKimariteRates {
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  const pct = (kimarite: string) => ((rows.find((r) => r.kimarite === kimarite)?.c ?? 0) / total) * 100;
  return {
    nige_pct: pct("逃"),
    makuri_pct: pct("捲"),
    sashi_pct: pct("差"),
    races: total,
  };
}

const STANDARD_BANK_LENGTHS = [333, 400, 500];

/**
 * 開催場の周長（333/400/500m）を、races.kyori/shukaiの平均（1周あたり距離）
 * から推定する。bank_infoテーブルのshuutyouはほとんどの開催場で未取得のため。
 */
export async function getVenueBankLength(jocd: string): Promise<number | null> {
  const result = await getDb().execute({
    sql: `SELECT AVG(kyori * 1.0 / shukai) as perLap FROM races
          WHERE jocd = ? AND kyori IS NOT NULL AND shukai IS NOT NULL AND shukai > 0`,
    args: [jocd],
  });
  const perLap = (result.rows[0] as unknown as { perLap: number | null })?.perLap;
  if (perLap == null) return null;
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const candidate of STANDARD_BANK_LENGTHS) {
    const diff = Math.abs(perLap - candidate);
    if (diff < bestDiff && diff <= 20) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

/**
 * 周長が同じ（333/400/500m）開催場をまとめて集計した決まり手割合。
 * 個別開催場が母数不足（getVenueKimariteRatesのminRaces未満）の場合の
 * 2段目のフォールバックとして使う。周長によって決まり手の傾向自体に
 * 差がある（例：333mは400mより差し決着の比率が低い）ことをバックテストで確認済み。
 */
export async function getBankLengthKimariteRates(
  bankLength: number,
  minRaces = 100
): Promise<VenueKimariteRates | null> {
  const venueRows = await getDb().execute(`
    SELECT jocd, AVG(kyori * 1.0 / shukai) as perLap
    FROM races
    WHERE kyori IS NOT NULL AND shukai IS NOT NULL AND shukai > 0
    GROUP BY jocd
  `);
  const matchingJocds = (venueRows.rows as unknown as { jocd: string; perLap: number }[])
    .filter((r) => Math.abs(r.perLap - bankLength) <= 20)
    .map((r) => r.jocd);
  if (matchingJocds.length === 0) return null;

  const result = await getDb().execute({
    sql: `SELECT r.kimarite, COUNT(*) as c
          FROM results r
          JOIN races ra ON ra.id = r.race_id
          WHERE ra.jocd IN (${matchingJocds.map(() => "?").join(",")})
            AND r.finish_pos = 1 AND r.kimarite IS NOT NULL
          GROUP BY r.kimarite`,
    args: matchingJocds,
  });
  const rows = result.rows as unknown as { kimarite: string; c: number }[];
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  if (total < minRaces) return null;
  return venueKimariteFromRows(rows);
}

/**
 * 開催場別の決まり手割合を、開催場単体→同じ周長の開催場まとめ→null（ニュートラル）
 * の順にフォールバックして取得する。
 */
export async function getVenueKimariteRatesWithFallback(
  jocd: string
): Promise<VenueKimariteRates | null> {
  const venueSpecific = await getVenueKimariteRates(jocd);
  if (venueSpecific) return venueSpecific;

  const bankLength = await getVenueBankLength(jocd);
  if (bankLength == null) return null;
  return getBankLengthKimariteRates(bankLength);
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

/**
 * 展開シナリオ別のバックテスト実績（的中率・回収率）を取得する。
 * scripts/backtest.tsが集計してscenario_statsテーブルに保存したキャッシュを読むだけで、
 * 買い目提案画面の表示のたびに全レースを再予想し直すことはしない。
 */
export async function getScenarioStats(): Promise<Record<string, ScenarioStatsRow>> {
  const result = await getDb().execute(
    "SELECT label, races, hits, stake_yen, payout_yen FROM scenario_stats"
  );
  const rows = result.rows as unknown as {
    label: string;
    races: number;
    hits: number;
    stake_yen: number;
    payout_yen: number;
  }[];
  const map: Record<string, ScenarioStatsRow> = {};
  for (const r of rows) {
    map[r.label] = {
      label: r.label,
      races: r.races,
      hits: r.hits,
      stakeYen: r.stake_yen,
      payoutYen: r.payout_yen,
      hitRate: r.races > 0 ? (r.hits / r.races) * 100 : 0,
      roi: r.stake_yen > 0 ? (r.payout_yen / r.stake_yen) * 100 : null,
    };
  }
  return map;
}

/** scripts/backtest.tsから呼び、展開シナリオ別の実績をscenario_statsテーブルにUPSERTする。 */
export async function saveScenarioStats(
  stats: { label: string; races: number; hits: number; stakeYen: number; payoutYen: number }[]
): Promise<void> {
  const db = getDb();
  const sql = `INSERT INTO scenario_stats (label, races, hits, stake_yen, payout_yen, updated_at)
               VALUES (?,?,?,?,?,datetime('now'))
               ON CONFLICT(label) DO UPDATE SET
                 races=excluded.races, hits=excluded.hits, stake_yen=excluded.stake_yen,
                 payout_yen=excluded.payout_yen, updated_at=datetime('now')`;
  await db.batch(
    stats.map((s) => ({ sql, args: [s.label, s.races, s.hits, s.stakeYen, s.payoutYen] }))
  );
}
