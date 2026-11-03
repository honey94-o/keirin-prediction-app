import { isOrdered, type BetType, type OddsEntry } from "./types";

/**
 * 予想家の「購入金額・点数・最高想定払戻」から、最高払戻になる1点の買い目を逆算する。
 *
 * 最高想定払戻 = その買い目のオッズ × その買い目への賭け金。オッズは0.1倍刻みなので、
 * 最高想定払戻 ÷ 賭け金 が0.1倍刻みで割り切れない賭け金はありえない。これで賭け金の
 * 候補を絞り、キリのいい金額（1000円単位 > 500円単位 > 100円単位）ほど重く見る。
 * 1点予想は賭け金＝購入金額なので推定オッズが1つに決まる。
 *
 * 想定払戻は予想の公開時点のオッズで計算されているはずで、今のオッズとはズレる。
 * そのため完全一致ではなく、推定オッズに対する比（対数）が許容幅に入る買い目を拾う。
 */

export type StakeTier = "fixed" | "A" | "B" | "C";

export const STAKE_TIER_LABEL: Record<StakeTier, string> = {
  fixed: "1点のため確定",
  A: "1000円単位",
  B: "500円単位",
  C: "100円単位",
};

const TIER_WEIGHT: Record<StakeTier, number> = { fixed: 1, A: 1, B: 0.45, C: 0.12 };

/** ライン予想で同じラインの選手同士の決着（ライン筋）を少しだけ上に出す倍率。 */
const LINE_BONUS = 1.25;

export type StakeCandidate = {
  stake: number;
  targetOdds: number;
  tier: StakeTier;
  /** 最高想定払戻 ÷ 賭け金 が0.1倍刻みで割り切れるか（1点予想で割り切れない時だけfalse）。 */
  exact: boolean;
};

export function stakeTier(stake: number): Exclude<StakeTier, "fixed"> {
  if (stake % 1000 === 0) return "A";
  if (stake % 500 === 0) return "B";
  return "C";
}

function dividesIntoOdds(maxPayout: number, stake: number): boolean {
  return (maxPayout * 10) % stake === 0;
}

/** 最高払戻の1点に置けた賭け金の上限（他の点に最低100円ずつ）。 */
function maxStakeFor(total: number, points: number): number {
  return total - (points - 1) * 100;
}

export function isValidInput(total: number, points: number, maxPayout: number): boolean {
  return (
    Number.isInteger(total) &&
    Number.isInteger(points) &&
    Number.isInteger(maxPayout) &&
    total >= 100 &&
    points >= 1 &&
    maxPayout >= 100 &&
    maxStakeFor(total, points) >= 100
  );
}

/** 最高想定払戻を作れる賭け金の候補（100円刻みで、0.1倍刻みのオッズになるものだけ）。 */
export function stakeCandidates(total: number, points: number, maxPayout: number): StakeCandidate[] {
  if (!isValidInput(total, points, maxPayout)) return [];
  if (points === 1) {
    return [{ stake: total, targetOdds: maxPayout / total, tier: "fixed", exact: dividesIntoOdds(maxPayout, total) }];
  }
  const out: StakeCandidate[] = [];
  for (let stake = 100; stake <= maxStakeFor(total, points); stake += 100) {
    if (!dividesIntoOdds(maxPayout, stake)) continue;
    const targetOdds = maxPayout / stake;
    if (targetOdds < 1) continue;
    out.push({ stake, targetOdds, tier: stakeTier(stake), exact: true });
  }
  return out;
}

/** 1000円単位のキリのいい賭け金のうち、割り切れないので除外したもの（画面の説明用）。 */
export function excludedRoundStakes(total: number, points: number, maxPayout: number): number[] {
  if (points === 1 || !isValidInput(total, points, maxPayout)) return [];
  const out: number[] = [];
  for (let stake = 1000; stake <= maxStakeFor(total, points); stake += 1000) {
    if (!dividesIntoOdds(maxPayout, stake)) out.push(stake);
  }
  return out;
}

function lineIndexByCar(lines: number[][]): Map<number, number> {
  const map = new Map<number, number>();
  lines.forEach((line, i) => {
    if (line.length >= 2) line.forEach((car) => map.set(car, i));
  });
  return map;
}

/** 1着・2着（2車複は2車）が同じラインか。3連複は判定しない（ほぼ常に同ラインの2車を含むため）。 */
function isLineCombo(key: number[], betType: BetType, lineOf: Map<number, number>): boolean {
  if (betType === "trio") return false;
  const a = lineOf.get(key[0]);
  return a !== undefined && a === lineOf.get(key[1]);
}

export type Candidate = OddsEntry & {
  stake: number;
  targetOdds: number;
  tier: StakeTier;
  /** 今のオッズ ÷ 推定オッズ。 */
  ratio: number;
  weight: number;
  lineMatch: boolean;
};

export function findCandidates(
  entries: OddsEntry[],
  stakes: StakeCandidate[],
  opts: { tolerance: number; tiers: StakeTier[]; betType: BetType; lines: number[][] },
): Candidate[] {
  const maxLog = Math.log(1 + opts.tolerance);
  const sigma = maxLog / 2;
  const lineOf = lineIndexByCar(opts.lines);
  const best = new Map<string, Candidate>();
  for (const sc of stakes) {
    if (sc.tier !== "fixed" && !opts.tiers.includes(sc.tier)) continue;
    for (const e of entries) {
      const logRatio = Math.log(e.odds / sc.targetOdds);
      if (Math.abs(logRatio) > maxLog) continue;
      const lineMatch = isLineCombo(e.key, opts.betType, lineOf);
      const weight = TIER_WEIGHT[sc.tier] * Math.exp(-0.5 * (logRatio / sigma) ** 2) * (lineMatch ? LINE_BONUS : 1);
      const id = e.key.join("-");
      const prev = best.get(id);
      if (!prev || prev.weight < weight) {
        best.set(id, { ...e, stake: sc.stake, targetOdds: sc.targetOdds, tier: sc.tier, ratio: e.odds / sc.targetOdds, weight, lineMatch });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}

export type CarShare = {
  car: number;
  /** 着順別の重みの割合（3連単は3要素、2車単は2要素、3連複・2車複は空）。 */
  byPos: number[];
  /** 着順を問わず買い目に含まれる重みの割合。 */
  any: number;
};

/** 候補の重みを車番ごとに集計する。軸の当たりをつける用。 */
export function carShares(candidates: Candidate[], betType: BetType, cars: number[]): CarShare[] {
  const positions = isOrdered(betType) ? (betType === "trifecta" ? 3 : 2) : 0;
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  const rows = new Map(cars.map((car) => [car, { car, byPos: Array(positions).fill(0) as number[], any: 0 }]));
  if (total === 0) return [...rows.values()];
  for (const c of candidates) {
    c.key.forEach((car, i) => {
      const row = rows.get(car);
      if (!row) return;
      if (i < positions) row.byPos[i] += c.weight / total;
      row.any += c.weight / total;
    });
  }
  return [...rows.values()];
}

export type RelatedEntry = OddsEntry & { relation: string };

export type ShapeHint = {
  remaining: number;
  /** 残りを均等に賭けたとき、最高想定払戻を超えないオッズの上限。 */
  capOdds: number;
  related: RelatedEntry[];
};

/** 候補と同じフォーメーションになりやすい買い目に付ける説明と優先順（小さいほど先）。 */
function relation(base: number[], other: number[], betType: BetType): { label: string; order: number } | null {
  if (betType === "trifecta") {
    if (other[0] === base[0] && other[1] === base[1]) return { label: "3着違い", order: 0 };
    if (other[0] === base[0]) return { label: "1着同じ", order: 1 };
    if (other[0] === base[1] && other[1] === base[0]) return { label: "1-2着裏", order: 2 };
    return null;
  }
  if (betType === "exacta") {
    if (other[0] === base[0]) return { label: "1着同じ", order: 0 };
    if (other[0] === base[1] && other[1] === base[0]) return { label: "裏", order: 1 };
    return null;
  }
  const shared = other.filter((car) => base.includes(car)).length;
  if (betType === "trio" && shared === 2) return { label: "2車同じ", order: 0 };
  if (betType === "quinella" && shared === 1) return { label: "1車同じ", order: 0 };
  return null;
}

/**
 * 2点以上の予想で、候補を最高払戻の1点としたときの残りの点の形の候補。
 * 残りの各点も払戻は最高想定払戻以下のはずなので、均等配分を仮定したオッズ上限で絞る。
 */
export function shapeHint(
  candidate: Candidate,
  entries: OddsEntry[],
  opts: { betType: BetType; total: number; points: number; maxPayout: number; limit?: number },
): ShapeHint | null {
  if (opts.points < 2) return null;
  const remaining = opts.total - candidate.stake;
  const capOdds = opts.maxPayout / (remaining / (opts.points - 1));
  const baseId = candidate.key.join("-");
  const related = entries
    .filter((e) => e.key.join("-") !== baseId && e.odds <= capOdds)
    .map((e) => ({ e, rel: relation(candidate.key, e.key, opts.betType) }))
    .filter((x): x is { e: OddsEntry; rel: { label: string; order: number } } => x.rel !== null)
    .sort((a, b) => a.rel.order - b.rel.order || a.e.odds - b.e.odds)
    .slice(0, opts.limit ?? 6)
    .map(({ e, rel }) => ({ ...e, relation: rel.label }));
  return { remaining, capOdds, related };
}
