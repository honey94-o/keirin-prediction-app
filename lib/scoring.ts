import type {
  BankInfoRow,
  BetSuggestion,
  EntryWithRacer,
  PositionWinRate,
  RaceScenario,
  RacerHistoryRow,
  ScoreBreakdown,
  ScoredEntry,
  ScoreWeights,
} from "./types";

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * ①ライン評価：ライン構成人数・隊列内の位置・地区の結びつきから算出する。
 * line_group/line_positionが無い（並び予想が未提供の）レースはニュートラル値を返す。
 */
export function calculateLineScore(
  entry: EntryWithRacer,
  allEntries: EntryWithRacer[]
): ScoreBreakdown {
  if (entry.line_group == null || entry.line_position == null) {
    return { score: 50, factors: { 理由: "ライン情報未提供のためニュートラル値" } };
  }

  const lineMates = allEntries.filter((e) => e.line_group === entry.line_group);
  const lineSize = lineMates.length;

  const baseByLineSize = lineSize >= 3 ? 80 : lineSize === 2 ? 60 : 40;

  const positionBonus =
    entry.line_position === "先頭" ? 5 : entry.line_position === "番手" ? 15 : 10;

  const prefs = new Set(lineMates.map((e) => e.pref).filter(Boolean));
  const samePrefBonus = lineSize >= 2 && prefs.size === 1 ? 5 : 0;

  const score = clamp(baseByLineSize + positionBonus + samePrefBonus);

  return {
    score,
    factors: {
      ライン人数: lineSize,
      隊列位置: entry.line_position,
      同県ライン: samePrefBonus > 0 ? "あり" : "なし",
      基礎点: baseByLineSize,
      位置加点: positionBonus,
      同県加点: samePrefBonus,
    },
  };
}

const CLASS_RANK_SCORES: Record<string, number> = {
  SS: 100,
  S1: 85,
  S2: 70,
  A1: 55,
  A2: 40,
  A3: 25,
};

// 数値が大きいほど上位級。昇級/降級の判定に使う（S級・A級の大まかな序列）。
const CLASS_RANK_ORDER: Record<string, number> = {
  SS: 6,
  S1: 5,
  S2: 4,
  A1: 3,
  A2: 2,
  A3: 1,
};

export type ClassChangeStatus = "昇級" | "降級" | "変動なし" | "不明";

export function determineClassChange(racer: {
  class_rank: string | null;
  prev_class_rank: string | null;
}): ClassChangeStatus {
  if (!racer.class_rank || !racer.prev_class_rank) return "不明";
  const cur = CLASS_RANK_ORDER[racer.class_rank];
  const prev = CLASS_RANK_ORDER[racer.prev_class_rank];
  if (cur == null || prev == null) return "不明";
  if (cur > prev) return "昇級";
  if (cur < prev) return "降級";
  return "変動なし";
}

/**
 * 競輪の級班替えは毎年1月・7月に行われる。切り替え直後は
 * 「今期級班での実績がまだ蓄積されていない」特殊期間として扱う
 * （降級直後は新しい級では相対的に格上＝狙い目、昇級直後は格上の相手と
 * 走るため苦戦しやすい、という定石を反映する）。
 * 1ヶ月目は影響が大きいとみて全量、2ヶ月目は影響が薄まるとみて半分の
 * 調整量を適用し、3ヶ月目以降は調整しない。
 */
export function classChangeAdjustmentFactor(kaisaiDate: string): number {
  const month = Number(kaisaiDate.slice(4, 6));
  // 1月=切替月、2月=1ヶ月後 / 7月=切替月、8月=1ヶ月後
  if (month === 1 || month === 7) return 1;
  if (month === 2 || month === 8) return 0.5;
  return 0;
}

/**
 * ②脚質・実力評価：級班・勝率・3着内率・脚質とライン内位置の相性・
 * 昇級/降級（切り替え直後1ヶ月のみ）から算出する。
 * ギア倍数は現状データ未取得のため考慮していない。
 */
export function calculateKyakushitsuScore(
  entry: EntryWithRacer,
  kaisaiDate: string
): ScoreBreakdown {
  const classRankScore = entry.class_rank
    ? CLASS_RANK_SCORES[entry.class_rank] ?? 50
    : 50;
  const winRateScore = entry.syouritu != null ? clamp(entry.syouritu) : 50;
  const placeRateScore = entry.rentairitu3 != null ? clamp(entry.rentairitu3) : 50;

  let fitScore = 50;
  if (entry.kyakushitsu && entry.line_position) {
    if (entry.kyakushitsu === "逃" && entry.line_position === "先頭") fitScore = 100;
    else if (entry.kyakushitsu === "追" && entry.line_position !== "先頭") fitScore = 100;
    else if (entry.kyakushitsu === "両") fitScore = 70;
    else fitScore = 40;
  }

  const baseScore = clamp(
    classRankScore * 0.25 + winRateScore * 0.3 + placeRateScore * 0.25 + fitScore * 0.2
  );

  const classChange = determineClassChange(entry);
  const adjustmentFactor = classChangeAdjustmentFactor(kaisaiDate);
  // 降級直後：新しい級の中では相対的に格上のため加点。
  // 昇級直後：格上の相手と走ることになるため減点。
  const baseAdjustment = classChange === "降級" ? 15 : classChange === "昇級" ? -10 : 0;
  const classChangeAdjustment = baseAdjustment * adjustmentFactor;

  const score = clamp(baseScore + classChangeAdjustment);

  return {
    score,
    factors: {
      級班: entry.class_rank ?? "不明",
      前期級班: entry.prev_class_rank ?? "不明",
      昇降級: classChange,
      昇降級調整係数: adjustmentFactor,
      昇降級調整点: classChangeAdjustment,
      勝率: entry.syouritu ?? "不明",
      "3着内率": entry.rentairitu3 ?? "不明",
      脚質: entry.kyakushitsu ?? "不明",
      "脚質×隊列位置の相性": fitScore,
    },
  };
}

/**
 * バンクの決まり手傾向（逃げ/捲り/差しの1着割合）と選手の脚質の相性。
 * 逃→バンクの「逃げ」率、追→バンクの「差し」率、両→バンクの「捲り」率を
 * それぞれ大まかな適性指標として採用する（公式に「脚質×バンク相性」の
 * 統計が存在しないための近似）。
 */
function calculateBankFitScore(
  entry: EntryWithRacer,
  bankInfo: BankInfoRow | undefined
): { score: number | null; usedPct: number | null } {
  if (!bankInfo || !entry.kyakushitsu) return { score: null, usedPct: null };
  const pct =
    entry.kyakushitsu === "逃"
      ? bankInfo.nige_pct
      : entry.kyakushitsu === "追"
        ? bankInfo.sashi_pct
        : bankInfo.makuri_pct;
  if (pct == null) return { score: null, usedPct: null };
  return { score: clamp(pct), usedPct: pct };
}

const MONTH_DAY_RE = /^(\d{2})\/(\d{2})$/;

function monthDayToDayOfYear(md: string): number | null {
  const m = MONTH_DAY_RE.exec(md);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  if (month < 1 || month > 12) return null;
  return cumulative[month - 1] + day;
}

/**
 * 出走間隔：直近の出走日から今回のレース日までの日数を評価する。
 * 日付は年をまたぐ厳密な特定をしていない簡易実装のため、
 * 日数差は「年内の日付として最も近い側」を採用する近似値。
 */
function calculateIntervalScore(
  kaisaiDate: string,
  history: RacerHistoryRow[]
): { score: number | null; days: number | null } {
  if (history.length === 0) return { score: null, days: null };
  const raceMonth = Number(kaisaiDate.slice(4, 6));
  const raceDay = Number(kaisaiDate.slice(6, 8));
  const raceDoy = monthDayToDayOfYear(
    `${String(raceMonth).padStart(2, "0")}/${String(raceDay).padStart(2, "0")}`
  );
  if (raceDoy == null) return { score: null, days: null };

  let minDiff: number | null = null;
  for (const h of history) {
    const doy = monthDayToDayOfYear(h.race_date);
    if (doy == null) continue;
    let diff = raceDoy - doy;
    if (diff < 0) diff += 365; // 年跨ぎの近似
    if (diff >= 0 && (minDiff == null || diff < minDiff)) minDiff = diff;
  }
  if (minDiff == null) return { score: null, days: null };

  // 連闘(0-2日)はやや減点、7-21日を最良、長期休養(60日超)は減点
  let score: number;
  if (minDiff <= 2) score = 60;
  else if (minDiff <= 6) score = 80;
  else if (minDiff <= 21) score = 100;
  else if (minDiff <= 40) score = 75;
  else if (minDiff <= 60) score = 55;
  else score = 35;

  return { score, days: minDiff };
}

/**
 * 過去の同条件（同開催場）成績：venue_abbrに現在の開催場名の文字が
 * 含まれる履歴を抽出し、平均着順から算出する近似値。
 * venue_abbrは1文字略称のため厳密な一致ではない点に注意。
 */
function calculateSameConditionScore(
  keirinjoName: string,
  history: RacerHistoryRow[]
): { score: number | null; matchedRaces: number; avgFinish: number | null } {
  const nameChars = [...keirinjoName.replace("競輪場", "")];
  const matched = history.filter(
    (h) => h.venue_abbr && nameChars.some((c) => h.venue_abbr!.includes(c))
  );
  if (matched.length === 0) return { score: null, matchedRaces: 0, avgFinish: null };

  const positions: number[] = [];
  for (const h of matched) {
    for (const p of h.finish_positions.split(",")) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) positions.push(n);
    }
  }
  if (positions.length === 0) return { score: null, matchedRaces: matched.length, avgFinish: null };

  const avgFinish = positions.reduce((a, b) => a + b, 0) / positions.length;
  // 平均着順1着=100点、9着以降=0点程度の線形マッピング
  const score = clamp(100 - (avgFinish - 1) * 12.5);
  return { score, matchedRaces: matched.length, avgFinish };
}

/**
 * 位置別勝率：entries.line_position × results.finish_pos の自前集計から、
 * 今回の隊列内位置と同じ位置での勝率を評価する。
 * 母数が少ないうちは極端な値（1走で100%等）になりやすいため、
 * 選手自身の通算勝率(syouritu)を事前分布としたベイズ的な縮小推定を行う。
 */
function calculatePositionWinRateScore(
  entry: EntryWithRacer,
  positionWinRates: PositionWinRate[]
): { score: number | null; races: number; rawRate: number | null } {
  if (!entry.line_position) return { score: null, races: 0, rawRate: null };
  const match = positionWinRates.find((p) => p.line_position === entry.line_position);
  if (!match || match.races === 0) return { score: null, races: 0, rawRate: null };

  const priorWeight = 3;
  const priorRate = (entry.syouritu ?? 15) / 100;
  const smoothedRate =
    (match.wins + priorWeight * priorRate) / (match.races + priorWeight);

  return { score: clamp(smoothedRate * 100), races: match.races, rawRate: match.winRate };
}

/**
 * ③データ統計評価：バンク適性・出走間隔・過去の同条件成績・位置別勝率・
 * 連対率を重み付け合成する。
 *
 * オッズは予想の参考にしない方針のため意図的に対象外にしている
 * （群衆の人気を自分のスコアに混ぜると、群衆と同じ判断に収束してしまうため）。
 * 天候も事前予報が取得できないため対象外
 * （レース終了後の実績値としてracesテーブルには保存しているが、
 * 予想スコアには反映していない。過去レースの振り返り分析用）。
 * 各要素はデータが無い場合ニュートラル(50点)にフォールバックする。
 */
export function calculateStatsScore(
  entry: EntryWithRacer,
  kaisaiDate: string,
  keirinjoName: string,
  bankInfo: BankInfoRow | undefined,
  history: RacerHistoryRow[],
  positionWinRates: PositionWinRate[]
): ScoreBreakdown {
  const bankResult = calculateBankFitScore(entry, bankInfo);
  const intervalResult = calculateIntervalScore(kaisaiDate, history);
  const sameConditionResult = calculateSameConditionScore(keirinjoName, history);
  const positionResult = calculatePositionWinRateScore(entry, positionWinRates);
  const rentaiScore = entry.rentairitu2 != null ? clamp(entry.rentairitu2) : null;

  const score = clamp(
    (bankResult.score ?? 50) * 0.2 +
      (intervalResult.score ?? 50) * 0.15 +
      (sameConditionResult.score ?? 50) * 0.2 +
      (positionResult.score ?? 50) * 0.2 +
      (rentaiScore ?? 50) * 0.25
  );

  return {
    score,
    factors: {
      バンク適性: bankResult.usedPct != null ? `${bankResult.usedPct}%` : "不明",
      出走間隔: intervalResult.days != null ? `${intervalResult.days}日` : "不明",
      同開催場平均着順: sameConditionResult.avgFinish?.toFixed(1) ?? "不明",
      同開催場該当数: sameConditionResult.matchedRaces,
      位置別勝率: positionResult.rawRate != null
        ? `${positionResult.rawRate.toFixed(0)}%(${positionResult.races}走・縮小推定後${positionResult.score?.toFixed(0)})`
        : "不明",
      連対率: entry.rentairitu2 ?? "不明",
      注記: "オッズは意図的に不使用。天候はレース終了後にしか取得できないため未反映",
    },
  };
}

const MARKS: ScoredEntry["mark"][] = ["◎", "○", "▲", "△", "×"];

export function scoreRace(
  entries: EntryWithRacer[],
  weights: ScoreWeights,
  kaisaiDate: string,
  keirinjoName: string,
  bankInfo: BankInfoRow | undefined,
  historyBySnum: Record<string, RacerHistoryRow[]>,
  positionWinRatesBySnum: Record<string, PositionWinRate[]>
): ScoredEntry[] {
  const scored = entries.map((entry) => {
    const lineScore = calculateLineScore(entry, entries);
    const kyakushitsuScore = calculateKyakushitsuScore(entry, kaisaiDate);
    const statsScore = calculateStatsScore(
      entry,
      kaisaiDate,
      keirinjoName,
      bankInfo,
      historyBySnum[entry.snum] ?? [],
      positionWinRatesBySnum[entry.snum] ?? []
    );
    const totalScore =
      lineScore.score * weights.line +
      kyakushitsuScore.score * weights.kyakushitsu +
      statsScore.score * weights.stats;

    return { entry, lineScore, kyakushitsuScore, statsScore, totalScore };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  return scored.map((s, i) => ({
    ...s,
    mark: MARKS[Math.min(i, MARKS.length - 1)],
  }));
}

const SANRENTAN_MAX_POINTS = 20;

/**
 * 軸（1着固定）と、あらかじめ優先順に並べた候補プールから
 * 「1頭軸流し」フォーメーションを生成する。2着・3着は同じプールを使う。
 * プールサイズMのとき点数は M×(M-1)（2着・3着に同じ車番は使えないため）。
 * maxPointsを超えない最大のMを自動選択する。
 */
function formationFromPool(axis: number, orderedPool: number[], maxPoints: number): string[] {
  if (orderedPool.length < 2) return [];

  let poolSize = 2;
  for (let m = 2; m <= orderedPool.length; m++) {
    if (m * (m - 1) > maxPoints) break;
    poolSize = m;
  }
  const candidates = orderedPool.slice(0, poolSize);

  const combos: string[] = [];
  for (const second of candidates) {
    for (const third of candidates) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

/**
 * 指定した軸（1着固定）と車番ランキングから、2着・3着の候補プール
 * （軸を除く総合スコア上位M頭）を使ったフォーメーションを生成する。
 * ライン等を考慮しない単純版で、predictionsテーブルの過去スナップショット
 * （車番と合計スコアのみ）から的中判定を再現する用途（lib/accuracy.ts）に使う。
 */
function generateSanrentanFormationForAxis(
  axis: number,
  ranked: number[],
  maxPoints: number = SANRENTAN_MAX_POINTS
): string[] {
  return formationFromPool(
    axis,
    ranked.filter((c) => c !== axis),
    maxPoints
  );
}

/** ◎（総合スコア1位）を軸にした標準フォーメーション。 */
function generateSanrentanFormation(
  ranked: number[],
  maxPoints: number = SANRENTAN_MAX_POINTS
): string[] {
  if (ranked.length < 3) return [];
  return generateSanrentanFormationForAxis(ranked[0], ranked, maxPoints);
}

/**
 * 3連単の組み合わせ一覧（例: ["1-3-6","1-3-7",...]）を、
 * 「軸-2着候補-3着候補」の桁連結表記（例: "1-37-123567"）に変換する。
 * 全組み合わせが単一の1着（軸）を共有していない場合（3連複ボックス等）はnullを返す。
 */
export function formatFormationNotation(combinations: string[]): string | null {
  if (combinations.length === 0) return null;

  const parsed = combinations.map((c) => c.split("-").map(Number));
  const axis = parsed[0][0];
  if (!parsed.every((p) => p[0] === axis)) return null;

  const seconds = new Set<number>();
  const thirds = new Set<number>();
  for (const [, second, third] of parsed) {
    seconds.add(second);
    thirds.add(third);
  }

  const sortedJoin = (s: Set<number>) => [...s].sort((a, b) => a - b).join("");
  return `${axis}-${sortedJoin(seconds)}-${sortedJoin(thirds)}`;
}

/**
 * 総合スコア順（降順）の車番配列から3連単フォーメーション・3連複ボックスを生成する。
 * predictionsテーブルに保存済みの過去の予想（車番と合計スコアのみ）からも
 * 同じロジックで再現できるよう、ScoredEntryではなく車番配列を受け取る形にしている。
 */
export function generateBetSuggestionsFromRanking(ranked: number[]): BetSuggestion[] {
  if (ranked.length < 3) return [];

  const formation = generateSanrentanFormation(ranked);

  const boxCars = ranked.slice(0, 4);
  const box = new Set<string>();
  for (let i = 0; i < boxCars.length; i++) {
    for (let j = i + 1; j < boxCars.length; j++) {
      for (let k = j + 1; k < boxCars.length; k++) {
        const combo = [boxCars[i], boxCars[j], boxCars[k]].sort((a, b) => a - b);
        box.add(combo.join("-"));
      }
    }
  }

  return [
    { betType: "3連単フォーメーション", combinations: formation },
    { betType: "3連複ボックス", combinations: [...box] },
  ];
}

export function generateBetSuggestions(scored: ScoredEntry[]): BetSuggestion[] {
  return generateBetSuggestionsFromRanking(scored.map((s) => s.entry.car_num));
}

/**
 * シナリオの2着・3着候補プールを「優先ライン」のメンバーを先頭に、
 * それ以外はスコア順で並べて返す（軸自身は除く）。
 * 優先ラインは展開ごとに意味が異なる：
 * - 本命／逃げ粘り込み：軸と同じライン（先頭が残れば道連れで番手・3番手も上位に来やすい）
 * - まくり/差し一撃：軸に差される側＝本命ライン（差した後ろに残るのは元々前にいた選手たち）
 */
function buildLineAwarePool(
  axisCarNum: number,
  priorityLineGroup: number | null,
  allScored: ScoredEntry[]
): number[] {
  const others = allScored.filter((s) => s.entry.car_num !== axisCarNum);
  const byScoreDesc = (a: ScoredEntry, b: ScoredEntry) => b.totalScore - a.totalScore;

  const priority = others
    .filter((s) => priorityLineGroup != null && s.entry.line_group === priorityLineGroup)
    .sort(byScoreDesc);
  const rest = others
    .filter((s) => !(priorityLineGroup != null && s.entry.line_group === priorityLineGroup))
    .sort(byScoreDesc);

  return [...priority, ...rest].map((s) => s.entry.car_num);
}

/**
 * 総合スコア最上位を機械的に軸にするだけでなく、レースの決着展開が
 * 複数ありうることを踏まえて2〜3パターンの軸候補を提示する。
 * 2着・3着候補は「総合上位」ではなく展開・ラインから絞り込み、
 * 全パターン合計で3連単の買い目が20点以内に収まるよう配分する。
 *
 * - 本命: 総合スコア1位がそのまま押し切る想定。2・3着は同じラインの仲間を優先
 * - 逃げ粘り込み: ライン先頭の選手が単独で粘り切る想定。2・3着は道連れになりやすい
 *   同じラインの番手・3番手を優先
 * - まくり/差し一撃: 先頭ではない位置で追い込み型（脚質が追・両）の選手が外から
 *   差す想定。2・3着は差される側＝本命ラインのメンバーを優先
 *   （バンクの捲り決まり手率が高いほど根拠として言及する）
 *
 * 同じ選手が複数パターンの軸に重複する場合はその後のパターンをスキップし、
 * 実質的に異なる決着筋だけを2パターン以上出すようにしている。
 */
export function generateScenarios(
  scored: ScoredEntry[],
  bankInfo: BankInfoRow | undefined
): RaceScenario[] {
  if (scored.length < 3) return [];

  const usedAxes = new Set<number>();
  type ScenarioSpec = {
    label: string;
    axis: ScoredEntry;
    reason: string;
    priorityLineGroup: number | null;
  };
  const specs: ScenarioSpec[] = [];

  // ① 本命：総合スコア1位。同じラインの仲間が続きやすい
  const honmei = scored[0];
  usedAxes.add(honmei.entry.car_num);
  specs.push({
    label: "本命",
    axis: honmei,
    reason: `総合スコア1位。${honmei.entry.class_rank ?? ""}・${honmei.entry.kyakushitsu ?? "-"}${
      honmei.entry.line_position ? `（${honmei.entry.line_position}）` : ""
    }で総合力が最も高い。`,
    priorityLineGroup: honmei.entry.line_group,
  });

  // ② 逃げ粘り込み：ライン先頭の選手がそのまま独走で粘る想定。同じラインが道連れになりやすい
  const leadCandidate = [...scored]
    .filter((s) => s.entry.line_position === "先頭" && !usedAxes.has(s.entry.car_num))
    .sort((a, b) => b.totalScore - a.totalScore)[0];
  if (leadCandidate) {
    usedAxes.add(leadCandidate.entry.car_num);
    specs.push({
      label: "逃げ粘り込み",
      axis: leadCandidate,
      reason: `ライン先頭（${leadCandidate.entry.kyakushitsu ?? "-"}）。番手・3番手に守られて主導権を握りやすく、そのまま逃げ切る展開を想定。`,
      priorityLineGroup: leadCandidate.entry.line_group,
    });
  }

  // ③ まくり/差し一撃：先頭以外で追い込み適性（脚質が追・両）が高い選手が外から差す想定。
  //    差された本命ラインのメンバーが2・3着に残りやすいとみて優先する
  const makuriCandidate = [...scored]
    .filter(
      (s) =>
        !usedAxes.has(s.entry.car_num) &&
        s.entry.line_position !== "先頭" &&
        (s.entry.kyakushitsu === "追" || s.entry.kyakushitsu === "両")
    )
    .sort((a, b) => b.totalScore - a.totalScore)[0];
  if (makuriCandidate) {
    usedAxes.add(makuriCandidate.entry.car_num);
    const bankNote =
      bankInfo?.makuri_pct != null
        ? `このバンクは捲り決着が${bankInfo.makuri_pct}%と出やすく、`
        : "";
    specs.push({
      label: "まくり/差し一撃",
      axis: makuriCandidate,
      reason: `${bankNote}${makuriCandidate.entry.line_position ?? "単騎"}から${
        makuriCandidate.entry.kyakushitsu
      }脚質を活かして外を一気に差す展開を想定。`,
      priorityLineGroup: honmei.entry.line_group,
    });
  }

  // 3連単の買い目は全パターン合計で20点以内に収める（1パターンあたりに均等配分）
  const perScenarioBudget = Math.floor(SANRENTAN_MAX_POINTS / specs.length);

  return specs.map((spec) => {
    const pool = buildLineAwarePool(spec.axis.entry.car_num, spec.priorityLineGroup, scored);
    return {
      label: spec.label,
      axisCarNum: spec.axis.entry.car_num,
      axisName: spec.axis.entry.name,
      reason: spec.reason,
      formation: {
        betType: "3連単フォーメーション",
        combinations: formationFromPool(spec.axis.entry.car_num, pool, perScenarioBudget),
      },
    };
  });
}
