import { getDb } from "./db";
import type {
  BankInfoRow,
  BarikataPickResult,
  BarikataPickRow,
  BarikataPicksPerformance,
  DailyPickResult,
  DailyPickRow,
  DailyPicksPerformance,
  EntryWithRacer,
  FavoriteRacerEntry,
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
  SoloWinRate,
  VenueKimariteRank,
  VenueKimariteRates,
} from "./types";

// ---- 読取キャッシュ（backtest / diagnose 系スクリプト専用） ----
// これらのスクリプトは同じ選手・同じ開催場の集計を何千レースぶんも引き直すため、
// 1回の実行の中でメモ化するだけで Turso への往復と読取行数が桁で減る。
// ただし Next.js のサーバープロセスは長時間生き続けるので、常時有効にすると
// 日次同期で追加されたデータが画面に反映されなくなる。既定では無効にし、
// スクリプト側で enableReadCache() を呼ぶか KEIRIN_READ_CACHE=1 を渡したときだけ有効化する。
let readCacheEnabled = process.env.KEIRIN_READ_CACHE === "1";
const venueKimariteCache = new Map<string, Promise<VenueKimariteRates | null>>();
const venueKimariteRankCache = new Map<string, Promise<VenueKimariteRank | null>>();
const racerHistoryCache = new Map<string, Promise<RacerHistoryRow[]>>();
const positionWinRatesCache = new Map<string, Promise<PositionWinRate[]>>();
const soloWinRateCache = new Map<string, Promise<SoloWinRate | null>>();
const bankInfoCache = new Map<string, Promise<BankInfoRow | undefined>>();
// getScoreWeights は引数を取らないので固定キーで1件だけ持つ。
const scoreWeightsCache = new Map<string, Promise<ScoreWeights>>();

/** 1回のスクリプト実行の中だけ読取結果をメモ化する。Next.js からは呼ばないこと。 */
export function enableReadCache(): void {
  readCacheEnabled = true;
}

/** メモ化した内容を捨てる（スクレイピング直後に再集計したい場合など）。 */
export function clearReadCache(): void {
  venueKimariteCache.clear();
  venueKimariteRankCache.clear();
  racerHistoryCache.clear();
  positionWinRatesCache.clear();
  soloWinRateCache.clear();
  bankInfoCache.clear();
  scoreWeightsCache.clear();
}

// Promise をそのままキャッシュする。predict.ts が出走選手ぶんを Promise.all で
// 並列に呼ぶため、値ではなく Promise を入れないと同じ snum のクエリが重複する。
function memoized<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  fetch: () => Promise<T>
): Promise<T> {
  if (!readCacheEnabled) return fetch();
  const cached = cache.get(key);
  if (cached) return cached;
  // 失敗を残すと以降ずっと同じエラーを返してしまうため、捨ててリトライ可能にする。
  const pending = fetch().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

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

/**
 * 直近のデータ同期時刻（UTC、"YYYY-MM-DD HH:MM:SS"）を返す。
 * racersはスクレイプのたびに（出走した選手ぶん）updated_atが更新されるため、
 * daily-sync.ymlが最後に成功した時刻の目安として使える。データが無ければnull。
 */
export async function getLastSyncedAt(): Promise<string | null> {
  const result = await getDb().execute(`SELECT MAX(updated_at) as last_synced FROM racers`);
  const row = result.rows[0] as unknown as { last_synced: string | null } | undefined;
  return row?.last_synced ?? null;
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

export async function getRacer(snum: string): Promise<RacerRow | undefined> {
  const result = await getDb().execute({
    sql: "SELECT * FROM racers WHERE snum = ?",
    args: [snum],
  });
  return result.rows[0] as unknown as RacerRow | undefined;
}

export async function isFavoriteRacer(snum: string): Promise<boolean> {
  const result = await getDb().execute({
    sql: "SELECT 1 FROM favorite_racers WHERE snum = ?",
    args: [snum],
  });
  return result.rows.length > 0;
}

export async function addFavoriteRacer(snum: string): Promise<void> {
  await getDb().execute({
    sql: "INSERT INTO favorite_racers (snum) VALUES (?) ON CONFLICT(snum) DO NOTHING",
    args: [snum],
  });
}

export async function removeFavoriteRacer(snum: string): Promise<void> {
  await getDb().execute({
    sql: "DELETE FROM favorite_racers WHERE snum = ?",
    args: [snum],
  });
}

/** お気に入り選手の一覧（/settings管理用）。登録が新しい順。 */
export async function getFavoriteRacers(): Promise<RacerRow[]> {
  const result = await getDb().execute(
    `SELECT rc.* FROM favorite_racers f
     JOIN racers rc ON rc.snum = f.snum
     ORDER BY f.created_at DESC`
  );
  return result.rows as unknown as RacerRow[];
}

/**
 * 指定日にお気に入り選手が出走するレース一覧（発走時刻順）。ホーム画面・
 * /favorites用。結果が確定していればfinishPosも返す（LEFT JOIN、未確定はnull）。
 */
export async function getFavoriteRacerEntriesForDate(
  kaisaiDate: string
): Promise<FavoriteRacerEntry[]> {
  const result = await getDb().execute({
    sql: `SELECT ra.*, e.car_num as entry_car_num, rc.snum as racer_snum, rc.name as racer_name,
                 r.finish_pos, r.kimarite
          FROM favorite_racers f
          JOIN entries e ON e.snum = f.snum
          JOIN races ra ON ra.id = e.race_id
          JOIN racers rc ON rc.snum = f.snum
          LEFT JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
          WHERE ra.kaisai_date = ?
          ORDER BY ra.start_time`,
    args: [kaisaiDate],
  });
  type Row = RaceRow & {
    entry_car_num: number;
    racer_snum: string;
    racer_name: string;
    finish_pos: number | null;
    kimarite: string | null;
  };
  return (result.rows as unknown as Row[]).map((r) => ({
    race: {
      id: r.id,
      kaisai_date: r.kaisai_date,
      jocd: r.jocd,
      keirinjo_name: r.keirinjo_name,
      race_no: r.race_no,
      syumoku: r.syumoku,
      grade_kbn: r.grade_kbn,
      kyori: r.kyori,
      shukai: r.shukai,
      start_time: r.start_time,
      encp: r.encp,
      tenki: r.tenki,
      husoku: r.husoku,
    },
    snum: r.racer_snum,
    racerName: r.racer_name,
    carNum: r.entry_car_num,
    finishPos: r.finish_pos,
    kimarite: r.kimarite,
  }));
}

export async function getEntriesForRace(raceId: number): Promise<EntryWithRacer[]> {
  const result = await getDb().execute({
    sql: `SELECT e.id as entry_id, e.race_id, e.car_num, e.line_group, e.line_position,
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
  return memoized(bankInfoCache, jocd, () => fetchBankInfo(jocd));
}

async function fetchBankInfo(jocd: string): Promise<BankInfoRow | undefined> {
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
  return memoized(venueKimariteCache, jocd, () => fetchVenueKimariteRatesWithFallback(jocd));
}

async function fetchVenueKimariteRatesWithFallback(
  jocd: string
): Promise<VenueKimariteRates | null> {
  const venueSpecific = await getVenueKimariteRates(jocd);
  if (venueSpecific) return venueSpecific;

  const bankLength = await getVenueBankLength(jocd);
  if (bankLength == null) return null;
  return getBankLengthKimariteRates(bankLength);
}

/**
 * 開催場の決まり手（逃/捲/差）割合が、実績データのある全開催場の中で何番目に
 * 高いかを返す。getVenueKimariteRatesと同じminRaces基準を満たす開催場だけを
 * ランキング対象にする（母数が少ない場をランキングに混ぜると自場・比較先
 * 双方の順位がノイズで振れるため）。対象jocd自身が基準未満なら null。
 */
export async function getVenueKimariteRank(
  jocd: string,
  minRaces = 40
): Promise<VenueKimariteRank | null> {
  return memoized(venueKimariteRankCache, `${jocd}:${minRaces}`, () =>
    fetchVenueKimariteRank(jocd, minRaces)
  );
}

async function fetchVenueKimariteRank(
  jocd: string,
  minRaces: number
): Promise<VenueKimariteRank | null> {
  const result = await getDb().execute(`
    SELECT ra.jocd as jocd, r.kimarite as kimarite, COUNT(*) as c
    FROM results r
    JOIN races ra ON ra.id = r.race_id
    WHERE r.finish_pos = 1 AND r.kimarite IS NOT NULL
    GROUP BY ra.jocd, r.kimarite
  `);
  const rows = result.rows as unknown as { jocd: string; kimarite: string; c: number }[];

  const byVenue = new Map<string, { kimarite: string; c: number }[]>();
  for (const row of rows) {
    const arr = byVenue.get(row.jocd) ?? [];
    arr.push({ kimarite: row.kimarite, c: row.c });
    byVenue.set(row.jocd, arr);
  }

  const rates = [...byVenue.entries()]
    .map(([venueJocd, rs]) => ({ jocd: venueJocd, ...venueKimariteFromRows(rs) }))
    .filter((v) => v.races >= minRaces);

  if (!rates.some((v) => v.jocd === jocd)) return null;

  const rankOf = (key: "nige_pct" | "makuri_pct" | "sashi_pct") => {
    const sorted = [...rates].sort((a, b) => b[key] - a[key]);
    const idx = sorted.findIndex((v) => v.jocd === jocd);
    return idx >= 0 ? idx + 1 : null;
  };

  return {
    totalVenues: rates.length,
    nigeRank: rankOf("nige_pct"),
    makuriRank: rankOf("makuri_pct"),
    sashiRank: rankOf("sashi_pct"),
  };
}

export async function getRacerHistory(snum: string): Promise<RacerHistoryRow[]> {
  return memoized(racerHistoryCache, snum, () => fetchRacerHistory(snum));
}

async function fetchRacerHistory(snum: string): Promise<RacerHistoryRow[]> {
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
  return memoized(positionWinRatesCache, snum, () => fetchPositionWinRates(snum));
}

async function fetchPositionWinRates(snum: string): Promise<PositionWinRate[]> {
  const result = await getDb().execute({
    sql: `SELECT e.line_position,
                 COUNT(*) as races,
                 SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins,
                 SUM(CASE WHEN r.finish_pos = 2 THEN 1 ELSE 0 END) as seconds,
                 SUM(CASE WHEN r.finish_pos = 3 THEN 1 ELSE 0 END) as thirds
          FROM entries e
          JOIN results r ON r.race_id = e.race_id AND r.snum = e.snum
          WHERE e.snum = ? AND e.line_position IS NOT NULL
          GROUP BY e.line_position`,
    args: [snum],
  });
  const rows = result.rows as unknown as {
    line_position: string;
    races: number;
    wins: number;
    seconds: number;
    thirds: number;
  }[];

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

/**
 * 選手個人の「単騎（自分のラインが自分だけ）時」の勝率。scripts/diagnose-
 * solo-personal.tsで検証（77,955出走、leave-one-out・heikin_tokuten三分位
 * 層別・train/testホールドアウトいずれも再現した強い信号）。
 * getPositionWinRatesはline_position（先頭/番手/3番手）別だが、単騎はWINTICKET上
 * line_positionが常に"先頭"表記のため、複数人ラインの先頭と区別できていない。
 * この関数だけ単騎かどうか（同レース同line_groupの出走が1人だけ）を
 * 相関サブクエリで判定して分ける。
 */
export async function getSoloWinRate(snum: string): Promise<SoloWinRate | null> {
  return memoized(soloWinRateCache, snum, () => fetchSoloWinRate(snum));
}

async function fetchSoloWinRate(snum: string): Promise<SoloWinRate | null> {
  const result = await getDb().execute({
    sql: `SELECT COUNT(*) as races, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
          FROM entries e
          JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
          WHERE e.snum = ? AND e.line_group IS NOT NULL
            AND (SELECT COUNT(*) FROM entries e2
                 WHERE e2.race_id = e.race_id AND e2.line_group = e.line_group) = 1`,
    args: [snum],
  });
  const row = result.rows[0] as unknown as { races: number; wins: number } | undefined;
  if (!row || row.races === 0) return null;
  return { races: row.races, wins: row.wins, winRate: (row.wins / row.races) * 100 };
}

const DEFAULT_WEIGHTS: ScoreWeights = { line: 0.35, kyakushitsu: 0.35, stats: 0.3 };

export async function getScoreWeights(): Promise<ScoreWeights> {
  return memoized(scoreWeightsCache, "singleton", () => fetchScoreWeights());
}

async function fetchScoreWeights(): Promise<ScoreWeights> {
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

/**
 * 発走前の予想（スコア・印）をスナップショットとして保存する。honmeiFormationは
 * その時点で実際に表示した「本命」シナリオの3連単フォーメーション（ライン考慮・
 * margin帯別の点数調整を反映済み）。◎行にのみ保存し、/history等の的中判定を
 * 実際に見せた買い目と一致させる（generateBetSuggestionsFromRankingという
 * 別ロジックで再計算していたのを廃止）。
 */
export async function savePrediction(
  raceId: number,
  scored: ScoredEntry[],
  honmeiFormation?: string[]
): Promise<void> {
  const db = getDb();
  const sql = `INSERT INTO predictions (race_id, car_num, snum, mark, total_score,
                                         line_score, kyakushitsu_score, stats_score, formation)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(race_id, car_num) DO UPDATE SET
                 mark=excluded.mark, total_score=excluded.total_score,
                 line_score=excluded.line_score, kyakushitsu_score=excluded.kyakushitsu_score,
                 stats_score=excluded.stats_score, formation=excluded.formation,
                 predicted_at=datetime('now')`;
  await db.batch(
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

export async function getPredictionsForRace(raceId: number): Promise<PredictionRow[]> {
  const result = await getDb().execute({
    sql: `SELECT car_num, snum, mark, total_score, line_score, kyakushitsu_score, stats_score, formation
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

/** IN句用のIDチャンク分割（1クエリあたりのパラメータ数を抑えるため）。 */
function chunkIds(ids: number[], size = 200): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

function groupBy<T>(rows: (T & { race_id: number })[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const arr = map.get(row.race_id) ?? [];
    arr.push(row);
    map.set(row.race_id, arr);
  }
  return map;
}

/**
 * 複数レース分のraces/predictions/results/oddsをまとめて取得する。
 * /history画面の集計（getOverallAccuracyStats等）が1レースずつ個別クエリで
 * N+1になっていたため（300レースでページ表示が3分近くかかっていた）、
 * IN句でのバルク取得に置き換えるために追加した。
 */
export async function getRacesByIds(raceIds: number[]): Promise<Map<number, RaceRow>> {
  const map = new Map<number, RaceRow>();
  if (raceIds.length === 0) return map;
  for (const chunk of chunkIds(raceIds)) {
    const result = await getDb().execute({
      sql: `SELECT * FROM races WHERE id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as RaceRow[]) map.set(row.id, row);
  }
  return map;
}

export async function getPredictionsForRaces(
  raceIds: number[]
): Promise<Map<number, PredictionRow[]>> {
  if (raceIds.length === 0) return new Map();
  const rows: (PredictionRow & { race_id: number })[] = [];
  for (const chunk of chunkIds(raceIds)) {
    const result = await getDb().execute({
      sql: `SELECT race_id, car_num, snum, mark, total_score, line_score, kyakushitsu_score, stats_score, formation
            FROM predictions WHERE race_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY race_id, total_score DESC`,
      args: chunk,
    });
    rows.push(...(result.rows as unknown as (PredictionRow & { race_id: number })[]));
  }
  return groupBy(rows);
}

export async function getResultsForRaces(raceIds: number[]): Promise<Map<number, ResultRow[]>> {
  if (raceIds.length === 0) return new Map();
  const rows: (ResultRow & { race_id: number })[] = [];
  for (const chunk of chunkIds(raceIds)) {
    const result = await getDb().execute({
      sql: `SELECT race_id, car_num, snum, finish_pos, kimarite
            FROM results WHERE race_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY race_id, finish_pos`,
      args: chunk,
    });
    rows.push(...(result.rows as unknown as (ResultRow & { race_id: number })[]));
  }
  return groupBy(rows);
}

/**
 * 出走選手にL級（ガールズケイリン）が1人でもいるレースIDの集合を返す。
 * lib/scoring.tsのisGirlsRaceと同じ判定基準（syumoku文字列は信用しない。
 * 理由はisGirlsRaceのコメント参照）。ガールズはラインが無く決まり方が
 * 通常のレースと異なるため、的中率・回収率の集計を分けるのに使う。
 */
export async function getGirlsRaceIds(raceIds: number[]): Promise<Set<number>> {
  if (raceIds.length === 0) return new Set();
  const ids = new Set<number>();
  for (const chunk of chunkIds(raceIds)) {
    const result = await getDb().execute({
      sql: `SELECT DISTINCT e.race_id FROM entries e
            JOIN racers rc ON rc.snum = e.snum
            WHERE e.race_id IN (${chunk.map(() => "?").join(",")}) AND rc.class_rank LIKE 'L%'`,
      args: chunk,
    });
    for (const row of result.rows as unknown as { race_id: number }[]) ids.add(row.race_id);
  }
  return ids;
}

export async function getOddsForRaces(raceIds: number[]): Promise<Map<number, OddsRow[]>> {
  if (raceIds.length === 0) return new Map();
  const rows: (OddsRow & { race_id: number })[] = [];
  for (const chunk of chunkIds(raceIds)) {
    const result = await getDb().execute({
      sql: `SELECT race_id, bet_type, combination, odds_value
            FROM odds WHERE race_id IN (${chunk.map(() => "?").join(",")}) AND bet_type = '3連単'`,
      args: chunk,
    });
    rows.push(...(result.rows as unknown as (OddsRow & { race_id: number })[]));
  }
  return groupBy(rows);
}

/**
 * 予想（predictions）と結果（results）の両方が揃っているレースIDの一覧。
 * /history画面の通算成績集計はレースごとにDBを複数回読むため、limitを
 * 付けずに全件（予想蓄積が増えるほど際限なく増える）処理すると重くなる。
 * デフォルトで直近300レースに絞る（履歴が浅いうちは実質全件になる）。
 */
export async function getRaceIdsWithPredictionAndResult(limit = 300): Promise<number[]> {
  const result = await getDb().execute({
    sql: `SELECT DISTINCT p.race_id
     FROM predictions p
     JOIN results r ON r.race_id = p.race_id
     ORDER BY p.race_id DESC
     LIMIT ?`,
    args: [limit],
  });
  return (result.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
}

/** 予想（predictions）を保存済みのレースID（結果未確定のものも含む）。同上の理由でlimit付き。 */
export async function getRaceIdsWithPrediction(limit = 300): Promise<number[]> {
  const result = await getDb().execute({
    sql: `SELECT DISTINCT race_id FROM predictions ORDER BY race_id DESC LIMIT ?`,
    args: [limit],
  });
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

/**
 * 結果未確定レースの◎-対抗スコア差（margin）をまとめて保存する（daily_picksテーブル）。
 * scripts/daily-picks.tsがdaily-sync.yml実行のたびに呼び、ホーム画面「本日の厳選
 * レース」用のキャッシュとして使う。predictRaceの都度計算は重い（1レースあたり
 * DB約20回）ため、事前計算しておきホーム画面では読むだけにする。
 */
export async function saveDailyPicks(
  picks: {
    raceId: number;
    kaisaiDate: string;
    jocd: string;
    keirinjoName: string;
    raceNo: number;
    startTime: string | null;
    margin: number;
    honmeiCarNum: number;
    honmeiName: string;
    formation: string[];
  }[]
): Promise<void> {
  if (picks.length === 0) return;
  const db = getDb();
  const sql = `INSERT INTO daily_picks (race_id, kaisai_date, jocd, keirinjo_name, race_no,
                                         start_time, margin, honmei_car_num, honmei_name, formation, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
               ON CONFLICT(race_id) DO UPDATE SET
                 margin=excluded.margin, honmei_car_num=excluded.honmei_car_num,
                 honmei_name=excluded.honmei_name, start_time=excluded.start_time,
                 formation=excluded.formation, updated_at=datetime('now')`;
  await db.batch(
    picks.map((p) => ({
      sql,
      args: [
        p.raceId,
        p.kaisaiDate,
        p.jocd,
        p.keirinjoName,
        p.raceNo,
        p.startTime,
        p.margin,
        p.honmeiCarNum,
        p.honmeiName,
        JSON.stringify(p.formation),
      ],
    }))
  );
}

/**
 * 指定日の厳選ピックを、本命marginが大きい順に上位limit件だけ取得する（ホーム画面・
 * /picks画面用）。scripts/simulate-selective-strategy.tsで122日分の実データを
 * シミュレーションした結果、margin自体にしきい値を設ける（例: margin>=10のみ採用）
 * よりも、しきい値を設けず「その日の中での上位」を機械的に選ぶ方が
 * 30日ローリング回収率の安定性（100%超えの窓の割合）・1日の採用件数の両面で
 * 優れていた（しきい値ありだと対象日が減り1日あたりの件数がユーザー希望の
 * 5〜10件を満たせない日が多発した）。そのためmargin条件は付けず、日付＋
 * 上位N件だけで絞り込む。
 */
export async function getDailyPicks(kaisaiDate: string, limit = 10): Promise<DailyPickRow[]> {
  const result = await getDb().execute({
    sql: `SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin,
                 honmei_car_num, honmei_name, formation
          FROM daily_picks WHERE kaisai_date = ? ORDER BY margin DESC LIMIT ?`,
    args: [kaisaiDate, limit],
  });
  const rows = result.rows as unknown as (Omit<DailyPickRow, "formation"> & { formation: string | null })[];
  return rows.map((r) => ({
    ...r,
    formation: r.formation ? (JSON.parse(r.formation) as string[]) : null,
  }));
}

/**
 * 実際の着順を1つの組み合わせ文字列に解決する（lib/accuracy.tsのcomputeRaceSummary・
 * scripts/backtest.ts等と同じロジック）。3連単の払戻オッズには賭けの勝敗判定に
 * 使われる確定済みの正しい着順がそのまま入っているため最優先で使う（稀な同着で
 * results.finish_posだけからは一意に組み立てられないケースの対策）。ただし初期の
 * 別スクレイパー由来の一部レースは全組み合わせのオッズ盤ごと保存されているため、
 * 組み合わせが1種類だけの時に限って信用する。
 */
export function resolveActualCombo(results: ResultRow[], odds: OddsRow[]): string | null {
  const top3 = results
    .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
    .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
  const sanrentanOdds = odds.filter((o) => o.bet_type === "3連単");
  const distinctCombos = new Set(sanrentanOdds.map((o) => o.combination));
  if (distinctCombos.size === 1) return sanrentanOdds[0].combination;
  if (top3.length < 3) return null;
  return top3.map((r) => r.car_num).join("-");
}

/**
 * 指定日の厳選ピック（上位10件）について、結果が確定していれば的中判定する。
 * その日実際に見せた買い目（daily_picks.formationのスナップショット）で判定する
 * ため、後からスコアリングロジックを変更しても過去の「前日の結果」表示は
 * 変わらない（predictRaceで都度再計算する方式だと、日々のチューニングのたびに
 * 過去の的中結果が書き換わってしまうため）。
 */
export async function getDailyPicksResults(kaisaiDate: string): Promise<DailyPickResult[]> {
  const picks = await getDailyPicks(kaisaiDate);
  if (picks.length === 0) return [];
  const raceIds = picks.map((p) => p.race_id);
  const [resultsMap, oddsMap] = await Promise.all([
    getResultsForRaces(raceIds),
    getOddsForRaces(raceIds),
  ]);

  return picks.map((pick) => {
    const results = resultsMap.get(pick.race_id) ?? [];
    const odds = oddsMap.get(pick.race_id) ?? [];
    const actualCombo = resolveActualCombo(results, odds);
    if (actualCombo == null || pick.formation == null) {
      return { pick, finished: false, hit: null, stakeYen: null, payoutYen: null };
    }
    const stakeYen = 100 * pick.formation.length;
    const hit = pick.formation.includes(actualCombo);
    const hitOdds =
      odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
    const payoutYen = hit && hitOdds != null ? 100 * hitOdds : 0;
    return { pick, finished: true, hit, stakeYen, payoutYen };
  });
}

/** 指定した日付リスト分の厳選ピック実績を合算する（回収率は総払戻/総賭け金）。 */
export async function getDailyPicksPerformance(dates: string[]): Promise<DailyPicksPerformance> {
  let races = 0;
  let hits = 0;
  let stakeYen = 0;
  let payoutYen = 0;

  for (const date of dates) {
    const results = await getDailyPicksResults(date);
    for (const r of results) {
      if (!r.finished) continue;
      races++;
      if (r.hit) hits++;
      stakeYen += r.stakeYen ?? 0;
      payoutYen += r.payoutYen ?? 0;
    }
  }

  return {
    days: dates.length,
    races,
    hits,
    stakeYen,
    payoutYen,
    roi: stakeYen > 0 ? (payoutYen / stakeYen) * 100 : null,
  };
}

/**
 * 「バリカタ」ピックを保存する。scripts/barikata-picks.tsから呼ぶ。
 * daily_picksと同じくスナップショット方式（あとでスコアリングを変えても
 * 過去の的中結果表示が変わらないようcomboを固定保存する）。
 */
export async function saveBarikataPicks(
  picks: {
    raceId: number;
    kaisaiDate: string;
    jocd: string;
    keirinjoName: string;
    raceNo: number;
    startTime: string | null;
    margin: number;
    combo: string;
    honmeiCarNum: number;
    honmeiName: string;
  }[]
): Promise<void> {
  if (picks.length === 0) return;
  const db = getDb();
  const sql = `INSERT INTO barikata_picks (race_id, kaisai_date, jocd, keirinjo_name, race_no,
                                            start_time, margin, combo, honmei_car_num, honmei_name, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
               ON CONFLICT(race_id) DO UPDATE SET
                 margin=excluded.margin, combo=excluded.combo,
                 honmei_car_num=excluded.honmei_car_num, honmei_name=excluded.honmei_name,
                 start_time=excluded.start_time, updated_at=datetime('now')`;
  await db.batch(
    picks.map((p) => ({
      sql,
      args: [
        p.raceId,
        p.kaisaiDate,
        p.jocd,
        p.keirinjoName,
        p.raceNo,
        p.startTime,
        p.margin,
        p.combo,
        p.honmeiCarNum,
        p.honmeiName,
      ],
    }))
  );
}

/** 指定日のバリカタピック（margin降順、既定で最大3件）。 */
export async function getBarikataPicks(kaisaiDate: string, limit = 3): Promise<BarikataPickRow[]> {
  const result = await getDb().execute({
    sql: `SELECT race_id, kaisai_date, jocd, keirinjo_name, race_no, start_time, margin, combo,
                 honmei_car_num, honmei_name
          FROM barikata_picks WHERE kaisai_date = ? ORDER BY margin DESC LIMIT ?`,
    args: [kaisaiDate, limit],
  });
  return result.rows as unknown as BarikataPickRow[];
}

/**
 * 指定日のバリカタピックの的中結果（単一の並びcomboが実際の結果と一致したか、
 * 1点=100円の的中判定）。
 */
export async function getBarikataPicksResults(kaisaiDate: string): Promise<BarikataPickResult[]> {
  const picks = await getBarikataPicks(kaisaiDate);
  if (picks.length === 0) return [];
  const raceIds = picks.map((p) => p.race_id);
  const [resultsMap, oddsMap] = await Promise.all([
    getResultsForRaces(raceIds),
    getOddsForRaces(raceIds),
  ]);

  return picks.map((pick) => {
    const results = resultsMap.get(pick.race_id) ?? [];
    const odds = oddsMap.get(pick.race_id) ?? [];
    const actualCombo = resolveActualCombo(results, odds);
    if (actualCombo == null) {
      return { pick, finished: false, hit: null, stakeYen: null, payoutYen: null };
    }
    const stakeYen = 100;
    const hit = pick.combo === actualCombo;
    const hitOdds =
      odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
    const payoutYen = hit && hitOdds != null ? 100 * hitOdds : 0;
    return { pick, finished: true, hit, stakeYen, payoutYen };
  });
}

/** 指定した日付リスト分のバリカタピック実績を合算する。 */
export async function getBarikataPicksPerformance(dates: string[]): Promise<BarikataPicksPerformance> {
  let races = 0;
  let hits = 0;
  let stakeYen = 0;
  let payoutYen = 0;

  for (const date of dates) {
    const results = await getBarikataPicksResults(date);
    for (const r of results) {
      if (!r.finished) continue;
      races++;
      if (r.hit) hits++;
      stakeYen += r.stakeYen ?? 0;
      payoutYen += r.payoutYen ?? 0;
    }
  }

  return {
    days: dates.length,
    races,
    hits,
    stakeYen,
    payoutYen,
    roi: stakeYen > 0 ? (payoutYen / stakeYen) * 100 : null,
  };
}
