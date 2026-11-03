/**
 * オッズ逆算ページ（/odds-guess）専用の型。既存の予想ロジック・DBとは独立していて、
 * WINTICKETのページから都度取得したオッズだけを扱う。
 */

export type BetType = "trifecta" | "exacta" | "trio" | "quinella";

export const BET_TYPES: BetType[] = ["trifecta", "exacta", "trio", "quinella"];

export const BET_TYPE_LABEL: Record<BetType, string> = {
  trifecta: "3連単",
  exacta: "2車単",
  trio: "3連複",
  quinella: "2車複",
};

/** 着順の区別がある券種（3連単・2車単）か。 */
export function isOrdered(betType: BetType): boolean {
  return betType === "trifecta" || betType === "exacta";
}

export type OddsEntry = {
  /** 車番の並び。3連複・2車複は昇順。 */
  key: number[];
  odds: number;
  popularity: number;
};

/** 開催中（当日・翌日）の場の一覧の1行。WINTICKETトップページの埋め込みデータから作る。 */
export type VenueOption = {
  /** YYYYMMDD */
  date: string;
  venueId: string;
  venueName: string;
  slug: string;
  cupId: string;
  /** 開催の何日目か（WINTICKETのURLの日目部分）。 */
  index: number;
  cupName: string;
  /** その場で今いちばん近いレースの番号（分からなければnull）。 */
  currentRace: number | null;
};

export type RaceOdds = {
  venueName: string;
  cupName: string;
  /** YYYYMMDD */
  date: string;
  race: {
    number: number;
    className: string;
    raceType: string;
    /** UNIX秒 */
    startAt: number;
    closeAt: number;
    entriesNumber: number;
    cancel: boolean;
  };
  entries: { number: number; name: string; absent: boolean }[];
  /** WINTICKETのライン予想。各ラインの車番（先頭から順）。 */
  lines: number[][];
  lineType: string;
  /** UNIX秒。0ならまだオッズが出ていない。 */
  oddsUpdatedAt: number;
  finalOdds: boolean;
  odds: Record<BetType, OddsEntry[]>;
};
