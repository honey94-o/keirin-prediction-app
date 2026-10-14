/**
 * 2・3着モデル（◎が1着した条件で、誰が2着・3着に来るか）。
 *
 * 旧来の2・3着候補はbuildLineAwarePool（◎と同ラインを機械的に先頭に並べる）だったが、
 * 2026-10の研究（scripts/research/second-third-model-pit.ts・gensen-design-pit.ts）で、
 * レース時点で分かっていた情報だけ（ライン構成＋本人の過去成績、racersの最新成績
 * スナップショットは使わない）で学習した2段のsoftmaxが、全ての時系列検証期間で
 * 旧並びを上回った（男子・◎1着レース、2着的中 50.6→52.1%、2・3着ペア1点的中
 * 22.2→25.5%）。旧並びは◎ラインの3番手を強い他ライン選手より上に置いていたが、
 * 実際には3番手は2着候補として弱い（sameFar係数が負）。
 *
 * ガールズは同じ手法で旧並びを上回れなかったため対象外（呼び出し側で旧並びを使う）。
 * 係数・事前分布は scripts/data/second-third-model-pit.json の models.men / priors。
 * 本体は scripts/research/pit-model.ts（検証に使ったもの）と同一。
 */

export type PosCat = "L" | "S" | "T" | "K";

export interface PitRecord {
  date: string; // YYYYMMDD
  finishPos: number;
  fieldSize: number;
  posCat: PosCat | null;
  kimarite: string | null;
}

export interface PitPriors {
  win: number;
  top2: number;
  top3: number;
  finNorm: number;
  posTop2: Record<PosCat, number>;
  kim: Record<"逃" | "捲" | "差" | "マ", number>;
  leadFreq: number;
}
export interface PitShrinkageK {
  form20: number; // 8
  recent5: number; // 4
  position: number; // 6
  kimariteAndLead: number; // 6
}

/** 窓の定義（second-third-model-pit.json の history 節と同じ） */
export const PIT_FORM_N = 20;
export const PIT_RECENT_N = 5;
export const PIT_WINDOW_DAYS = 120;

export interface PitForm {
  nPrior: number; // 直近20走窓の走数（0〜20）
  top2: number;
  top3: number;
  win: number;
  finNorm: number;
  rec3: number;
  posTop2: Record<PosCat, number>;
  nige: number;
  makuri: number;
  sashi: number;
  mark: number;
  leadFreq: number;
}

const shrink = (x: number, n: number, p: number, k: number) => (x + k * p) / (n + k);

function minusDays(yyyymmdd: string, days: number): string {
  const t = Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) - days * 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 時点成績。history は順不同で可（raceDate以降の行は自動的に無視する）。
 *   form20 : 日付降順で直近20走（日数制限なし）
 *   recent5: 直近5走
 *   120日窓: date >= raceDate-120日 かつ date < raceDate、posCat非NULLの走のみ
 * 縮約: (件数 + K·prior) / (走数 + K)
 */
export function computeForm(history: PitRecord[], raceDate: string, priors: PitPriors, K: PitShrinkageK): PitForm {
  const past = history.filter((r) => r.date < raceDate).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  let n = 0, w = 0, t2 = 0, t3 = 0, af = 0, r3 = 0, rn = 0;
  for (const r of past) {
    if (n >= PIT_FORM_N) break;
    n++;
    if (r.finishPos === 1) w++;
    if (r.finishPos <= 2) t2++;
    if (r.finishPos <= 3) t3++;
    af += Math.min(1, (r.finishPos - 1) / Math.max(1, r.fieldSize - 1));
    if (rn < PIT_RECENT_N) {
      rn++;
      if (r.finishPos <= 3) r3++;
    }
  }
  const since = minusDays(raceDate, PIT_WINDOW_DAYS);
  const pc: Record<PosCat, [number, number]> = { L: [0, 0], S: [0, 0], T: [0, 0], K: [0, 0] };
  const kc = { 逃: 0, 捲: 0, 差: 0, マ: 0 };
  let np = 0, lead = 0;
  for (const r of past) {
    if (r.date < since) break;
    if (r.posCat == null) continue;
    np++;
    pc[r.posCat][0]++;
    if (r.finishPos <= 2) pc[r.posCat][1]++;
    if (r.finishPos <= 2 && r.kimarite != null && r.kimarite in kc) kc[r.kimarite as keyof typeof kc]++;
    if (r.posCat === "L") lead++;
  }
  const posTop2 = {} as Record<PosCat, number>;
  for (const p of ["L", "S", "T", "K"] as PosCat[]) posTop2[p] = shrink(pc[p][1], pc[p][0], priors.posTop2[p], K.position);
  return {
    nPrior: n,
    top2: shrink(t2, n, priors.top2, K.form20),
    top3: shrink(t3, n, priors.top3, K.form20),
    win: shrink(w, n, priors.win, K.form20),
    finNorm: shrink(af, n, priors.finNorm, K.form20),
    rec3: shrink(r3, rn, priors.top3, K.recent5),
    posTop2,
    nige: shrink(kc["逃"], np, priors.kim["逃"], K.kimariteAndLead),
    makuri: shrink(kc["捲"], np, priors.kim["捲"], K.kimariteAndLead),
    sashi: shrink(kc["差"], np, priors.kim["差"], K.kimariteAndLead),
    mark: shrink(kc["マ"], np, priors.kim["マ"], K.kimariteAndLead),
    leadFreq: shrink(lead, np, priors.leadFreq, K.kimariteAndLead),
  };
}

// ---------------------------------------------------------------- features
export interface PitEntry {
  car: number;
  lineGroup: number | null;
  linePos: string | null; // '先頭' | '番手' | '3番手' | ...
  form: PitForm;
}
export const SECOND_FEATURES = [
  "sameBehind1", "sameFront", "sameFar", "behind1_hNotLeader", "behind1_hNige", "behind1_mark",
  "rivalLeader", "rivalLeader_big", "rivalSecond", "rivalThird", "tanki", "car1to3",
  "fTop2", "fTop3", "fWin", "fFin", "fRec3", "fPosTop2", "fNige", "fMakuri", "fSashi", "fMark", "fLead", "fNewbie",
] as const;
export const THIRD_FEATURES = [...SECOND_FEATURES, "sameAs2nd", "behind2nd1", "front2nd", "sameAs2nd_and2ndSameH"] as const;

const POS_NUM: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4, "5番手": 5, "6番手": 6 };
const posNum = (p: string | null) => POS_NUM[p ?? ""] ?? 1;

export interface PitRaceCtx {
  h: PitEntry;
  others: PitEntry[];
  lineSize: Map<number, number>;
  girls: boolean;
}
export function buildRaceCtx(entries: PitEntry[], honmeiCar: number, girls: boolean): PitRaceCtx {
  const h = entries.find((e) => e.car === honmeiCar);
  if (!h) throw new Error(`honmei car ${honmeiCar} not in entries`);
  const lineSize = new Map<number, number>();
  for (const e of entries) if (e.lineGroup != null) lineSize.set(e.lineGroup, (lineSize.get(e.lineGroup) ?? 0) + 1);
  return { h, others: entries.filter((e) => e.car !== honmeiCar), lineSize, girls };
}

/** 2着段の特徴ベクトル（SECOND_FEATURESの順）。ガールズはライン構造を全て0にする。 */
export function secondFeatureVector(c: PitEntry, x: PitRaceCtx): number[] {
  const g = x.girls;
  const same = !g && x.h.lineGroup != null && c.lineGroup === x.h.lineGroup;
  const ph = posNum(x.h.linePos);
  const pc = posNum(c.linePos);
  const behind1 = same && pc === ph + 1 ? 1 : 0;
  const ls = c.lineGroup != null ? x.lineSize.get(c.lineGroup) ?? 1 : 1;
  const rivalLeader = !g && !same && ls >= 2 && c.linePos === "先頭" ? 1 : 0;
  const cat: PosCat = g || ls <= 1 ? "K" : c.linePos === "先頭" ? "L" : c.linePos === "番手" ? "S" : "T";
  const f = c.form;
  return [
    behind1,
    same && pc < ph ? 1 : 0,
    same && pc >= ph + 2 ? 1 : 0,
    behind1 * (x.h.linePos === "先頭" ? 0 : 1),
    behind1 * x.h.form.nige,
    behind1 * f.mark,
    rivalLeader,
    rivalLeader * (ls >= 3 ? 1 : 0),
    !g && !same && ls >= 2 && c.linePos === "番手" ? 1 : 0,
    !g && !same && ls >= 3 && pc >= 3 ? 1 : 0,
    !g && ls === 1 ? 1 : 0,
    c.car <= 3 ? 1 : 0,
    f.top2,
    f.top3,
    f.win,
    f.finNorm,
    f.rec3,
    f.posTop2[cat],
    f.nige,
    f.makuri,
    f.sashi,
    f.mark,
    f.leadFreq,
    f.nPrior < 5 ? 1 : 0,
  ];
}
/** 3着段（2着=s が決まった条件下）の特徴ベクトル（THIRD_FEATURESの順）。 */
export function thirdFeatureVector(c: PitEntry, s: PitEntry, x: PitRaceCtx): number[] {
  const same2 = !x.girls && s.lineGroup != null && c.lineGroup === s.lineGroup;
  const ps = posNum(s.linePos);
  const pc = posNum(c.linePos);
  const sSameH = !x.girls && x.h.lineGroup != null && s.lineGroup === x.h.lineGroup;
  return [...secondFeatureVector(c, x), same2 ? 1 : 0, same2 && pc === ps + 1 ? 1 : 0, same2 && pc < ps ? 1 : 0, same2 && sSameH ? 1 : 0];
}

export function softmax(u: number[]): number[] {
  const m = Math.max(...u);
  const e = u.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
const dot = (v: number[], names: readonly string[], w: Record<string, number>) =>
  v.reduce((a, x, i) => a + x * (w[names[i]] ?? 0), 0);

export interface PitCoefs {
  second: Record<string, number>;
  third: Record<string, number>;
}
export interface PairProb {
  second: number; // 車番
  third: number; // 車番
  p: number; // P(2着=second, 3着=third | ◎1着)
}

/**
 * ◎(honmeiCar)が1着した条件での (2着,3着) ペア確率、降順。
 *   P(2着=j) = softmax_j( Σ_f second[f]·x_f(j) )
 *   P(3着=k | 2着=j) = softmax_{k≠j}( Σ_f third[f]·x_f(k; j) )
 *   p(j,k) = P(2着=j)·P(3着=k|2着=j)   （候補n人ならn(n-1)組、合計1）
 */
export function pairProbabilities(entries: PitEntry[], honmeiCar: number, coefs: PitCoefs, opts: { girls: boolean }): PairProb[] {
  const x = buildRaceCtx(entries, honmeiCar, opts.girls);
  const p2 = softmax(x.others.map((c) => dot(secondFeatureVector(c, x), SECOND_FEATURES, coefs.second)));
  const out: PairProb[] = [];
  x.others.forEach((s, j) => {
    const rest = x.others.filter((_, i) => i !== j);
    const p3 = softmax(rest.map((c) => dot(thirdFeatureVector(c, s, x), THIRD_FEATURES, coefs.third)));
    rest.forEach((t, k) => out.push({ second: s.car, third: t.car, p: p2[j] * p3[k] }));
  });
  return out.sort((a, b) => b.p - a.p);
}

export const PIT_PRIORS: PitPriors = {
  win: 0.14322,
  top2: 0.28623,
  top3: 0.42888,
  finNorm: 0.49963,
  posTop2: { L: 0.36681, S: 0.33303, T: 0.09081, K: 0.23525 },
  kim: { 逃: 0.06622, 捲: 0.06425, 差: 0.0965, マ: 0.05926 },
  leadFreq: 0.32032,
};

export const PIT_SHRINKAGE_K: PitShrinkageK = { form20: 8, recent5: 4, position: 6, kimariteAndLead: 6 };

/** 男子モデル（2026-04〜10の◎1着レース4,557件で学習）。 */
export const PIT_MEN_COEFS: PitCoefs = {
  second: {
    sameBehind1: 1.37682, sameFront: 1.18947, sameFar: -0.34234, behind1_hNotLeader: -0.36274,
    behind1_hNige: 0.87704, behind1_mark: -0.11052, rivalLeader: -0.21999, rivalLeader_big: -0.0399,
    rivalSecond: -0.2049, rivalThird: -1.16253, tanki: -0.39246, car1to3: 0.24629,
    fTop2: 0.73925, fTop3: 0.54412, fWin: 0.27136, fFin: -2.19836, fRec3: 0.42083, fPosTop2: 0.46143,
    fNige: -0.16062, fMakuri: -0.41777, fSashi: 0.4883, fMark: -0.18077, fLead: 0.48372, fNewbie: -0.20601,
  },
  third: {
    sameBehind1: 0.58696, sameFront: 0.73645, sameFar: -0.05862, behind1_hNotLeader: 0.49415,
    behind1_hNige: 0.33299, behind1_mark: -0.33244, rivalLeader: -0.01217, rivalLeader_big: 0.01593,
    rivalSecond: -0.17332, rivalThird: -0.68802, tanki: 0.05003, car1to3: 0.20616,
    fTop2: 0.15681, fTop3: -0.24672, fWin: -0.42914, fFin: -4.05403, fRec3: 0.56272, fPosTop2: -0.01346,
    fNige: -0.41525, fMakuri: 0.24914, fSashi: 0.57647, fMark: 0.05161, fLead: 0.13689, fNewbie: -0.66408,
    sameAs2nd: 0.21117, behind2nd1: 1.1104, front2nd: 0.31356, sameAs2nd_and2ndSameH: 0.20434,
  },
};

/** entriesの位置表記と同ライン人数から過去走の位置区分を決める（computeFormの入力用）。 */
export function posCatOf(linePosition: string | null, lineGroup: number | null, lineSize: number): PosCat {
  if (lineGroup == null || lineSize <= 1) return "K";
  if (linePosition === "先頭") return "L";
  if (linePosition === "番手") return "S";
  return "T";
}
