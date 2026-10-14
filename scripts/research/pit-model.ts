/**
 * 2・3着モデル（リーク無し版 / point-in-time）の純粋関数モジュール。依存ゼロ（importなし）。
 * 係数は scripts/data/second-third-model-pit.json の models.men / models.girls（second / third）。
 * 検証は scripts/research/second-third-model-pit.ts と gensen-design-pit.ts。
 *
 * 使い方（本番移植の想定）:
 *   1. 各出走選手について、そのレースの開催日より前の自分の出走履歴 PitRecord[] をDBから集める
 *      （results.finish_pos が非NULLの行。races.kaisai_date < 今回の開催日。同日は含めない）。
 *      各行に必要なもの:
 *        date      = races.kaisai_date (YYYYMMDD)
 *        finishPos = results.finish_pos
 *        fieldSize = そのレースのresults行数（＝完走頭数。取れなければ entries の頭数で可）
 *        posCat    = そのレースでの本人の位置区分（entries.line_position と、同じ race_id・同じ
 *                    line_group の entries 人数 n から）:
 *                      n<=1 または line_group NULL → "K"（単騎）
 *                      line_position='先頭' → "L" / '番手' → "S" / それ以外(3番手,4番手…) → "T"
 *                    entries が無い行は null（form20/recent5 にだけ使われ、120日窓系では無視）
 *        kimarite  = results.kimarite（'逃'|'捲'|'差'|'マ'|null。1・2着にだけ入っている）
 *   2. computeForm(history, raceDate, priors, shrinkageK) で PitForm を作る。
 *   3. pairProbabilities(entries, honmeiCar, coefs, { girls }) で (2着,3着) ペア確率を降順で得る。
 *      ◎ = 本番の totalScore 1位（予想の軸）。候補は◎以外の全員。
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
