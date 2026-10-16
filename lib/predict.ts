import {
  getRace,
  getEntriesForRace,
  getEntriesForRaces,
  getScoreWeights,
  getBankInfo,
  getRacerHistories,
  getPositionWinRatesForRacers,
  getSoloWinRate,
  getGirlsAgariAbility,
  getVenueKimariteRatesWithFallback,
  getPitHistories,
  isReadCacheEnabled,
  primeRaceCache,
} from "./repository";
import {
  computeForm,
  pairProbabilities,
  PIT_MEN_COEFS,
  PIT_PRIORS,
  PIT_SHRINKAGE_K,
  type PairProb,
} from "./second-third-model";
import {
  scoreRace,
  generateBetSuggestions,
  generateScenarios,
  HIGH_CONFIDENCE_MARGIN,
  SOLO_ADJUSTMENT_ENABLED,
  GIRLS_AGARI_ADJUSTMENT_ENABLED,
} from "./scoring";
import type {
  BankInfoRow,
  BetSuggestion,
  GirlsAgariAbility,
  RaceRow,
  RaceScenario,
  ScoredEntry,
  SoloWinRate,
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
  /** ◎1着時の(2着,3着)ペア確率・降順（lib/second-third-model.ts）。ガールズはnull。 */
  secondThird: PairProb[] | null;
}

/**
 * レースIDから、スコアリングに必要なデータ一式を集めて予想結果を組み立てる。
 * CLI（scripts/test-scoring.ts）とUI（app/races/[id]）の両方から共有して使う。
 */
export async function predictRace(raceId: number): Promise<RacePrediction | null> {
  const race = await getRace(raceId);
  if (!race) return null;

  // 以下は互いに依存しないため並列に投げる（Neonへの往復待ちを直列に積まない）。
  const [entries, weights, bankInfo, venueKimarite] = await Promise.all([
    getEntriesForRace(raceId),
    getScoreWeights(),
    getBankInfo(race.jocd),
    // このレースより後の実績が混ざらないよう、race.kaisai_dateを日付カットオフとして
    // 渡す（過去のレースをバックテストする際に未来の情報が漏れ込む=lookahead biasを
    // 防ぐため。ライブの当日レースではkaisai_date=今日なので、実質的に「今日時点で
    // 存在する実績」＝これまでと同じ挙動になる）。
    getVenueKimariteRatesWithFallback(race.jocd, race.kaisai_date),
  ]);

  // 選手単位の入力は出走選手ぶんを1クエリずつにまとめて取る（以前は選手×種類ごとに
  // 1クエリで、1レース約30往復になっていた）。
  const snums = entries.map((e) => e.snum);
  const girlsSnums = entries.filter((e) => e.class_rank?.startsWith("L")).map((e) => e.snum);
  // 2・3着モデルの対象（男子・3車以上）。scoreRaceはentriesを並べ替えるだけなので
  // ここで判定して他の取得と並列に投げる（下でscoredに対して同じ条件を確かめ直す）。
  const wantsPitModel = girlsSnums.length === 0 && entries.length >= 3;
  const [historyMap, positionMap, soloWinRateBySnum, girlsAgariAbilityBySnum, prefetchedPitHistories] =
    await Promise.all([
      getRacerHistories(snums, race.kaisai_date),
      getPositionWinRatesForRacers(snums, race.kaisai_date),
      SOLO_ADJUSTMENT_ENABLED
        ? Promise.all(snums.map(async (s) => [s, await getSoloWinRate(s, race.kaisai_date)] as const)).then(
            (pairs) => Object.fromEntries(pairs)
          )
        : ({} as Record<string, SoloWinRate | null>),
      // ガールズ（L級）以外はcalculateGirlsAgariAdjustmentが即0を返すため、
      // L級以外の選手ぶんはクエリ自体を発行しない。
      GIRLS_AGARI_ADJUSTMENT_ENABLED
        ? Promise.all(girlsSnums.map(async (s) => [s, await getGirlsAgariAbility(s, race.kaisai_date)] as const)).then(
            (pairs) => Object.fromEntries(pairs)
          )
        : ({} as Record<string, GirlsAgariAbility | null>),
      wantsPitModel ? getPitHistories(snums, race.kaisai_date) : null,
    ]);
  const historyBySnum = Object.fromEntries(entries.map((e) => [e.snum, historyMap.get(e.snum) ?? []]));
  const positionWinRatesBySnum = Object.fromEntries(entries.map((e) => [e.snum, positionMap.get(e.snum) ?? []]));

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
  // 2・3着モデル（男子のみ。ガールズは旧並びの方が良かったため使わない）。
  const isGirls = scored.some((s) => s.entry.class_rank?.startsWith("L"));
  let secondThird: PairProb[] | null = null;
  if (!isGirls && scored.length >= 3) {
    const histories =
      prefetchedPitHistories ??
      (await getPitHistories(
        scored.map((s) => s.entry.snum),
        race.kaisai_date
      ));
    const pitEntries = scored.map((s) => ({
      car: s.entry.car_num,
      lineGroup: s.entry.line_group,
      linePos: s.entry.line_position,
      form: computeForm(histories.get(s.entry.snum) ?? [], race.kaisai_date, PIT_PRIORS, PIT_SHRINKAGE_K),
    }));
    secondThird = pairProbabilities(pitEntries, scored[0].entry.car_num, PIT_MEN_COEFS, { girls: false });
  }

  const scenarios = generateScenarios(scored, venueKimarite ?? bankInfo, secondThird);
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

  return { race, bankInfo, venueKimarite, scored, scenarios, boxSuggestion, winSuggestion, secondThird };
}

/**
 * スクリプト（compute-picks / daily-summary）用：多数のレースにpredictRaceを呼ぶ前に、
 * 出走表・選手履歴・位置別勝率・2-3着モデル用履歴を開催日ごとに数クエリでまとめて
 * 先読みし、読取キャッシュ（enableReadCache）に入れておく。以後のpredictRaceは
 * キャッシュから読むだけになり、1回の実行のクエリ数が数千→数十に減る。
 * races は getRacesByDate 等で取得済みの races 行（SELECT *）を渡す。
 * キャッシュ無効時は先読みしても捨てられるだけなので何もしない。
 */
export async function prefetchRaceInputs(races: RaceRow[]): Promise<void> {
  if (!isReadCacheEnabled() || races.length === 0) return;
  primeRaceCache(races);
  const entriesByRace = await getEntriesForRaces(races.map((r) => r.id));

  const byDate = new Map<string, { snums: Set<string>; pitSnums: Set<string> }>();
  for (const race of races) {
    const entries = entriesByRace.get(race.id) ?? [];
    const group = byDate.get(race.kaisai_date) ?? { snums: new Set<string>(), pitSnums: new Set<string>() };
    byDate.set(race.kaisai_date, group);
    for (const e of entries) group.snums.add(e.snum);
    // predictRaceと同じ条件（男子・3車以上）のレースだけ2-3着モデル用履歴を取る
    if (entries.length >= 3 && !entries.some((e) => e.class_rank?.startsWith("L"))) {
      for (const e of entries) group.pitSnums.add(e.snum);
    }
  }

  await Promise.all(
    [...byDate].flatMap(([kaisaiDate, { snums, pitSnums }]) => [
      getRacerHistories([...snums], kaisaiDate),
      getPositionWinRatesForRacers([...snums], kaisaiDate),
      pitSnums.size > 0 ? getPitHistories([...pitSnums], kaisaiDate) : Promise.resolve(null),
    ])
  );
}
