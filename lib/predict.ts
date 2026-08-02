import {
  getRace,
  getEntriesForRace,
  getScoreWeights,
  getBankInfo,
  getRacerHistory,
  getPositionWinRates,
} from "./repository";
import { scoreRace, generateBetSuggestions } from "./scoring";
import type { BankInfoRow, BetSuggestion, RaceRow, ScoredEntry } from "./types";

export interface RacePrediction {
  race: RaceRow;
  bankInfo: BankInfoRow | undefined;
  scored: ScoredEntry[];
  betSuggestions: BetSuggestion[];
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
    bankInfo,
    historyBySnum,
    positionWinRatesBySnum
  );
  const betSuggestions = generateBetSuggestions(scored);

  return { race, bankInfo, scored, betSuggestions };
}
