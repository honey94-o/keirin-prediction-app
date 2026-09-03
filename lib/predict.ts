import {
  getRace,
  getEntriesForRace,
  getScoreWeights,
  getBankInfo,
  getRacerHistory,
  getPositionWinRates,
  getVenueKimariteRatesWithFallback,
} from "./repository";
import { scoreRace, generateBetSuggestions, generateScenarios, HIGH_CONFIDENCE_MARGIN } from "./scoring";
import type {
  BankInfoRow,
  BetSuggestion,
  RaceRow,
  RaceScenario,
  ScoredEntry,
  VenueKimariteRates,
} from "./types";

export interface RacePrediction {
  race: RaceRow;
  bankInfo: BankInfoRow | undefined;
  /** ①ライン評価等が実際に参照した決まり手データ（自場実績→同周長グループ実績）。
   *  bank_info静的値まで含めた最終フォールバックはbankInfo側で表示側が解決する。 */
  venueKimarite: VenueKimariteRates | null;
  scored: ScoredEntry[];
  /** 展開パターン別の予想（本命／逃げ粘り込み／まくり差し等）。2〜3パターン。 */
  scenarios: RaceScenario[];
  /** 3連複ボックス（展開パターンに依らない上位車番の総当たり）。 */
  boxSuggestion: BetSuggestion | undefined;
  /**
   * 本命と対抗のスコア差がHIGH_CONFIDENCE_MARGIN以上の時だけ出す単勝おすすめ。
   * この条件では単勝的中率81.7%以上を実績確認済み（scripts/diagnose-confidence.ts）。
   */
  winSuggestion: { carNum: number; name: string; margin: number } | null;
}

/**
 * レースIDから、スコアリングに必要なデータ一式を集めて予想結果を組み立てる。
 * CLI（scripts/test-scoring.ts）とUI（app/races/[id]）の両方から共有して使う。
 */
export async function predictRace(raceId: number): Promise<RacePrediction | null> {
  const race = await getRace(raceId);
  if (!race) return null;

  const entries = await getEntriesForRace(raceId);
  const weights = await getScoreWeights();
  const bankInfo = await getBankInfo(race.jocd);
  const venueKimarite = await getVenueKimariteRatesWithFallback(race.jocd);

  const historyEntries = await Promise.all(
    entries.map(async (e) => [e.snum, await getRacerHistory(e.snum)] as const)
  );
  const historyBySnum = Object.fromEntries(historyEntries);

  const positionEntries = await Promise.all(
    entries.map(async (e) => [e.snum, await getPositionWinRates(e.snum)] as const)
  );
  const positionWinRatesBySnum = Object.fromEntries(positionEntries);

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
    race.shukai
  );
  const scenarios = generateScenarios(scored, venueKimarite ?? bankInfo);
  const boxSuggestion = generateBetSuggestions(scored).find(
    (s) => s.betType === "3連複ボックス"
  );

  let winSuggestion: RacePrediction["winSuggestion"] = null;
  if (scored.length >= 2) {
    const margin = scored[0].totalScore - scored[1].totalScore;
    if (margin >= HIGH_CONFIDENCE_MARGIN) {
      winSuggestion = { carNum: scored[0].entry.car_num, name: scored[0].entry.name, margin };
    }
  }

  return { race, bankInfo, venueKimarite, scored, scenarios, boxSuggestion, winSuggestion };
}
