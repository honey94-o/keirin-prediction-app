/**
 * レース詳細（/races/[id]）・選手（/racers/[snum]）・設定（/settings）画面用のDB読み取り。
 *
 * これらの画面はISR（初回表示時に生成→CDNにキャッシュ）にしているため、画面内の
 * DB読み取りは全てここ経由（cachedQuery＝タグ付きデータキャッシュ）にすること。
 * cachedQueryを通さずに読むと、その値はタグを持たないままページのHTMLに焼き付き、
 * 同期ジョブやServer Actionからの失効（lib/cache.ts参照）が届かなくなる。
 *
 * 結果はJSONで保存されるため Map/Set を返さない（必要なら画面側で組み立て直す）。
 * 同じ開催・同じ日・同じ開催場で共通の読み取りは、キーをレースIDではなく
 * 開催日/jocd単位にして複数レースの画面で使い回す。
 */
import { getDb } from "../db";
import { cachedQuery, CACHE_TAGS } from "../cache";
import {
  getRace,
  getResultsForRace,
  getScenarioStats,
  getScenarioRankStats,
  getVenueKimariteRank,
  getRacer,
  getRacerHistory,
  getPositionWinRates,
  isFavoriteRacer,
  getScoreWeights,
  getFavoriteRacers,
} from "../repository";
import type { LinePartnershipOccurrence, OddsRow, RaceRow, ResultRow, SoloWinRate } from "../types";

const { races: RACES, results: RESULTS, picks: PICKS, settings: SETTINGS, favorites: FAVORITES } = CACHE_TAGS;

// ---- レース詳細 ----

/** レース行だけ（開催日・jocdが分かれば他の読み取りを予想計算と並行して始められるため）。 */
export const getRaceRow = cachedQuery(
  "race.row",
  async (raceId: number): Promise<RaceRow | null> => (await getRace(raceId)) ?? null,
  [RACES]
);

/** 「この予想を記録する」済みか。予想行そのものは画面で使わないので存在だけ見る。 */
export const isPredictionRecorded = cachedQuery(
  "race.isPredictionRecorded",
  async (raceId: number): Promise<boolean> => {
    const result = await getDb().execute({
      sql: "SELECT 1 FROM predictions WHERE race_id = ? LIMIT 1",
      args: [raceId],
    });
    return result.rows.length > 0;
  },
  [PICKS]
);

export interface RaceOutcome {
  results: ResultRow[];
  /** 画面は3連単の払戻しか使わない（resolveActualCombo・的中オッズ）ため他の券種は取らない。 */
  sanrentanOdds: OddsRow[];
}

export const getRaceOutcome = cachedQuery(
  "race.outcome",
  async (raceId: number): Promise<RaceOutcome> => {
    const [results, odds] = await Promise.all([
      getResultsForRace(raceId),
      getDb().execute({
        sql: "SELECT bet_type, combination, odds_value, ninki FROM odds WHERE race_id = ? AND bet_type = '3連単'",
        args: [raceId],
      }),
    ]);
    return { results, sanrentanOdds: odds.rows as unknown as OddsRow[] };
  },
  [RESULTS]
);

export interface EventRaceTab {
  id: number;
  raceNo: number;
  finished: boolean;
}

/** 同じ開催（同日・同開催場）のレース切り替えタブ。終了判定は件数だけ数えて1クエリで済ませる。 */
export const getEventRaceTabs = cachedQuery(
  "race.eventTabs",
  async (kaisaiDate: string, jocd: string): Promise<EventRaceTab[]> => {
    const result = await getDb().execute({
      sql: `SELECT ra.id, ra.race_no,
                   (SELECT COUNT(*) FROM results r WHERE r.race_id = ra.id AND r.finish_pos IS NOT NULL) AS finished_count
            FROM races ra
            WHERE ra.kaisai_date = ? AND ra.jocd = ?
            ORDER BY ra.race_no ASC`,
      args: [kaisaiDate, jocd],
    });
    const rows = result.rows as unknown as { id: number; race_no: number; finished_count: number }[];
    // lib/repository.ts isRaceFinished と同じ基準（着順が3人分以上確定していれば終了）
    return rows.map((r) => ({ id: r.id, raceNo: r.race_no, finished: r.finished_count >= 3 }));
  },
  [RACES, RESULTS]
);

export interface VenueRaceOption {
  jocd: string;
  keirinjoName: string;
  /** その開催場の[レースID, 発走時刻]（発走時刻順）。飛び先は選択時に端末の現在時刻で決める。 */
  races: [number, string | null][];
}

/**
 * 開催場切り替えドロップダウンの選択肢（同日の全開催場）。並び順は以前と同じく
 * 開催場名→レース番号順に集めて、各開催場の最小レース番号の発走時刻で並べ替える。
 * 「今行くならどのレースか」は時刻依存なのでここでは決めず、レース一覧ごと渡す
 * （components/VenueSwitcher.tsx が選択時に決める）。
 */
export const getVenueOptionsForDate = cachedQuery(
  "race.venueOptions",
  async (kaisaiDate: string): Promise<VenueRaceOption[]> => {
    const result = await getDb().execute({
      sql: `SELECT id, jocd, keirinjo_name, start_time FROM races
            WHERE kaisai_date = ? ORDER BY keirinjo_name ASC, race_no ASC`,
      args: [kaisaiDate],
    });
    const rows = result.rows as unknown as Pick<RaceRow, "id" | "jocd" | "keirinjo_name" | "start_time">[];
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!groups.has(r.jocd)) groups.set(r.jocd, []);
      groups.get(r.jocd)!.push(r);
    }
    const byStartTime = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");
    return [...groups.entries()]
      .map(([jocd, groupRaces]) => ({
        jocd,
        keirinjoName: groupRaces[0].keirinjo_name,
        startTime: groupRaces[0].start_time,
        races: [...groupRaces]
          .sort((a, b) => byStartTime(a.start_time, b.start_time))
          .map((r): [number, string | null] => [r.id, r.start_time]),
      }))
      .sort((a, b) => byStartTime(a.startTime, b.startTime))
      .map(({ jocd, keirinjoName, races }) => ({ jocd, keirinjoName, races }));
  },
  [RACES]
);

/** 全開催場の集計から順位を出すが、結果は開催場ごとにキャッシュする。 */
export const getVenueKimariteRankCached = cachedQuery(
  "race.venueKimariteRank",
  (jocd: string) => getVenueKimariteRank(jocd),
  [RACES, RESULTS]
);

/** 展開シナリオ別・有力度別の実績（全レース共通のキャッシュ1件）。 */
export const getScenarioStatsBundle = cachedQuery(
  "race.scenarioStats",
  async () => {
    const [byLabel, byRank] = await Promise.all([getScenarioStats(), getScenarioRankStats()]);
    return { byLabel, byRank };
  },
  [PICKS]
);

/**
 * 今のライン（lines[i]＝そのラインの選手snum）ごとの、過去に同じラインを組んだレース。
 * lib/repository.ts getLinePartnershipHistory をライン数ぶん呼ぶのと同じ結果を1クエリで返す。
 * 旧版は対象選手の全出走行（数百行×ライン数）を取ってから「2人以上そろったライン」だけを
 * 残していたため、そろった行だけをDB側で絞って返す（1レースあたりの転送量の大半だった）。
 */
export const getLinePartnerships = cachedQuery(
  "race.linePartnerships",
  async (lines: string[][], beforeDate: string): Promise<LinePartnershipOccurrence[][]> => {
    const targets = lines.flatMap((snums, lineIdx) => (snums.length >= 2 ? snums.map((s) => [s, lineIdx] as const) : []));
    if (targets.length === 0) return lines.map(() => []);
    const result = await getDb().execute({
      sql: `WITH target(snum, line_idx) AS (VALUES ${targets.map(() => "(?::text, ?::int)").join(",")}),
            m AS (
              SELECT e.race_id, e.line_group, e.snum, e.car_num, t.line_idx
              FROM entries e
              JOIN target t ON t.snum = e.snum
              JOIN races ra ON ra.id = e.race_id
              WHERE ra.kaisai_date < ? AND e.line_group IS NOT NULL
            ),
            g AS (
              SELECT race_id, line_group, line_idx FROM m
              GROUP BY race_id, line_group, line_idx HAVING COUNT(*) >= 2
            )
            SELECT m.line_idx, m.race_id, ra.kaisai_date, ra.keirinjo_name, ra.race_no, ra.jocd, ra.encp,
                   m.line_group, m.snum, m.car_num, r.finish_pos
            FROM m
            JOIN g ON g.race_id = m.race_id AND g.line_group = m.line_group AND g.line_idx = m.line_idx
            JOIN races ra ON ra.id = m.race_id
            LEFT JOIN results r ON r.race_id = m.race_id AND r.car_num = m.car_num
            ORDER BY ra.kaisai_date DESC, m.race_id, m.car_num`,
      args: [...targets.flat(), beforeDate],
    });
    const rows = result.rows as unknown as {
      line_idx: number;
      race_id: number;
      kaisai_date: string;
      keirinjo_name: string;
      race_no: number;
      jocd: string;
      encp: string | null;
      line_group: number;
      snum: string;
      car_num: number;
      finish_pos: number | null;
    }[];

    // 以降は getLinePartnershipHistory と同じ組み立て（行の出現順でまとめ、開催日の新しい順）
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.line_idx}:${r.race_id}:${r.line_group}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const out: LinePartnershipOccurrence[][] = lines.map(() => []);
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      out[first.line_idx].push({
        raceId: first.race_id,
        kaisaiDate: first.kaisai_date,
        keirinjoName: first.keirinjo_name,
        raceNo: first.race_no,
        jocd: first.jocd,
        encp: first.encp,
        members: groupRows.map((r) => ({ snum: r.snum, carNum: r.car_num, finishPos: r.finish_pos })),
      });
    }
    return out.map((occ) => occ.sort((a, b) => b.kaisaiDate.localeCompare(a.kaisaiDate)));
  },
  [RACES, RESULTS]
);

/**
 * 単騎選手ごとの単騎時勝率（lib/repository.ts getSoloWinRate と同じ集計を選手ぶん1クエリで）。
 * 該当なし・0走はnull。
 */
export const getSoloWinRates = cachedQuery(
  "race.soloWinRates",
  async (snums: string[], beforeDate: string): Promise<Record<string, SoloWinRate | null>> => {
    if (snums.length === 0) return {};
    const result = await getDb().execute({
      sql: `SELECT e.snum, COUNT(*) as races, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
            FROM entries e
            JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
            JOIN races ra ON ra.id = e.race_id
            WHERE e.snum IN (${snums.map(() => "?").join(",")}) AND e.line_group IS NOT NULL AND ra.kaisai_date < ?
              AND (SELECT COUNT(*) FROM entries e2
                   WHERE e2.race_id = e.race_id AND e2.line_group = e.line_group) = 1
            GROUP BY e.snum`,
      args: [...snums, beforeDate],
    });
    const bySnum = new Map(
      (result.rows as unknown as { snum: string; races: number; wins: number }[]).map((r) => [r.snum, r])
    );
    return Object.fromEntries(
      snums.map((snum) => {
        const row = bySnum.get(snum);
        return [
          snum,
          !row || row.races === 0 ? null : { races: row.races, wins: row.wins, winRate: (row.wins / row.races) * 100 },
        ];
      })
    );
  },
  [RACES, RESULTS]
);

// ---- 選手 ----

/** 選手ページの本体（お気に入り状態は別キャッシュ：トグルのたびに重い集計を取り直さないため）。 */
export const getRacerProfile = cachedQuery(
  "racer.profile",
  async (snum: string) => {
    const [racer, history, positionWinRates] = await Promise.all([
      getRacer(snum),
      getRacerHistory(snum),
      getPositionWinRates(snum),
    ]);
    return racer ? { racer, history, positionWinRates } : null;
  },
  [RACES, RESULTS]
);

export const getIsFavoriteRacer = cachedQuery("racer.isFavorite", (snum: string) => isFavoriteRacer(snum), [FAVORITES]);

// ---- 設定 ----

export const getScoreWeightsCached = cachedQuery("settings.scoreWeights", () => getScoreWeights(), [SETTINGS]);

/** 選手名・級班（racers）も表示するため races タグも付ける。 */
export const getFavoriteRacersCached = cachedQuery(
  "settings.favoriteRacers",
  () => getFavoriteRacers(),
  [FAVORITES, RACES]
);
