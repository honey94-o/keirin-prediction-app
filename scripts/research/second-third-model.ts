/**
 * 【検証結果: 採用候補（男子：2着・2-3着ペアの予測精度がtrain/test両方で現行honmeiPool順を明確に上回る。
 *   女子：ほぼ互角（tokuten順と同等、確率の較正はやや過信）で積極採用の根拠なし）】
 *
 * 問い：◎(entries[0])が1着したとき、2着・3着に誰が来るか。現行はhonmeiPool順
 * （◎と同ラインを全員先に並べ、各群をlineupOrderScore順）。
 * 手法：候補=◎以外の全員。条件付きロジット（レース内softmax）を2段で fit：
 *   P(2着=j | ◎1着) ∝ exp(w2·x_j)、P(3着=k | ◎1着, 2着=j) ∝ exp(w3·x_k(j))
 *   （Plackett-Luce型、3着段は「2着と同ライン/2着の直後/2着より前」等を追加）。
 *   ニュートン法＋L2(λ=2)。train = date < 20260726、test = 以降（厳選と同じ分割）。
 *   母集団：◎1着・同着除外の全レース（男子 train2,817/test1,740、女子 469/273）。
 *   係数・特徴量定義は scripts/data/second-third-model.json に保存。
 *
 * ■ 男子 test（◎1着 1,740件）           2着top1 top2  | ペアtop1 top2 top3 top4 top6 top10 | LL2   LLpair
 *   モデル                               54.9  74.6   | 27.7 42.6 51.0 58.3 68.7 81.2   | 1.240 2.534
 *   現行 honmeiPool順(順位logitで較正)   50.6  66.4   | 22.2 32.2 40.3 47.8 57.9 69.3   | 1.450 2.950
 *   totalScore順                         45.1  66.8   | 16.7 27.0 34.8 40.6 53.0 68.0   | 1.504 3.039
 *   tokuten順                            41.1  63.0   | 13.9 23.7 31.8 39.7 50.4 68.6   | 1.557 3.082
 *   （trainでも同順：モデル52.6/72.6, pair 27.5..78.6 vs pool 48.8/65.2, pair 22.0..67.8）
 *   厳選test(◎1着56件): モデル 2着top1 55.4 ペアtop1/2/4/10 35.7/48.2/62.5/85.7
 *                        vs pool 50.0, 28.6/39.3/51.8/71.4（train 111件でも同方向）
 *   バリカタtest(◎1着81件): モデル 61.7, ペアtop1 45.7 vs pool 50.6/30.9, totalScore順 58.0/40.7
 *   較正（男子test、2着確率10分位 予測→実績）：1.8→1.7 … 19.1→21.8, 36.0→34.9, 66.5→65.9 ＝良好。
 *        ペア確率も 27.9→29.8, 13.6→13.9 等ほぼ対角。女子は上位分位で過信（57.9→46.9）。
 *
 * ■ 実戦形式（全レース母数＝◎負けも含む、100円/点）
 *   バリカタ1点: train 現行23.0%(51/222)→モデルtop1ペア27.0%(60)、test 33.3%(33/99)→37.4%(37)
 *   厳選（現行と同点数のモデル上位ペア）: train 的中44.4%→56.1%・回収82.2%→139.1%、
 *        test 的中43.8%→53.9%・回収202.4%→124.6%（n=89、現行testは少数の高配当的中に依存。
 *        回収率はtrain/testで方向が割れるので「的中率は確実に上がる、回収は未確定」）。
 *
 * ■ 主な係数（男子2着）：◎直後(番手)+1.72、◎より前(◎が番手時の先頭)+1.65、◎の2つ以上後ろ+0.34、
 *   他ライン先頭+0.57、他ライン番手+0.56、単騎+0.83、tokZ+0.44、scoreZ+0.28、直後×本人マーク率+0.70、
 *   直後×◎非先頭−0.31。honmeiPool順位の係数はほぼ0（モデルの情報に吸収される）。
 *   ポイント：現行は「◎ライン3番手」を他ラインの強い先頭・番手より上に置くが、データ上
 *   3番手は2着候補としては弱い（+0.34）。3着段では「2着の直後」+1.09が効く（ライン連れ込み）。
 *
 * ■ ルックアヘッド注意：racersの成績は現時点スナップショット。ablation（男子test）：
 *   ren2/ren3除外 → top1 54.5 / pair@1 27.1 / LLpair 2.576、
 *   スナップショット成績を全部除外（ライン構造+scoreZのみ）→ 52.8 / 25.2 / 2.726、
 *   ライン構造+tokZ+scoreZの8特徴量版 → 54.7 / 26.6 / 2.590。
 *   いずれも現行pool順（50.6/22.2/2.950）を上回り、改善の大半はライン構造の重み付けから来る
 *   ＝小さなルックアヘッド由来の上積みではない。移植は8特徴量版でも十分。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  loadCache,
  selectGensen,
  isBarikataCandidate,
  currentBarikataCombo,
  honmeiCombos,
  type CRace,
  type CEntry,
} from "../lib/research-cache";

const CUT = "20260726";
const POS: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4, "5番手": 5 };

// ---------------------------------------------------------------- features
interface Ctx {
  h: CEntry;
  others: CEntry[];
  lineSize: Map<number, number>;
  nLines: number;
  poolRank: Map<number, number>;
  tokMean: number;
  tokSd: number;
  tokMax: number;
  scMean: number;
  scSd: number;
  stMean: number;
  stSd: number;
  blMean: number;
  blSd: number;
  hMakuriGtNige: number;
  hIsLeader: number;
  maxRivalLeaderNige: number;
  girls: boolean;
}

const nz = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? 0 : x);
function meanSd(xs: number[]): [number, number] {
  if (xs.length === 0) return [0, 1];
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return [m, Math.sqrt(v) || 1];
}
function kimShares(e: CEntry) {
  const n = nz(e.nige), m = nz(e.makuri), s = nz(e.sashi), k = nz(e.mark);
  const t = n + m + s + k;
  return t === 0 ? { nige: 0, makuri: 0, mark: 0, none: 1 } : { nige: n / t, makuri: m / t, mark: k / t, none: 0 };
}

function buildCtx(r: CRace): Ctx {
  const h = r.entries[0];
  const others = r.entries.slice(1);
  const lineSize = new Map<number, number>();
  for (const e of r.entries) if (e.lineGroup != null) lineSize.set(e.lineGroup, (lineSize.get(e.lineGroup) ?? 0) + 1);
  const poolRank = new Map<number, number>();
  r.honmeiPool.forEach((c, i) => poolRank.set(c, i));
  const toks = others.map((e) => e.tokuten).filter((x): x is number => x != null);
  const [tokMean, tokSd] = meanSd(toks);
  const [scMean, scSd] = meanSd(others.map((e) => e.totalScore));
  const [stMean, stSd] = meanSd(others.map((e) => nz(e.standing)));
  const [blMean, blSd] = meanSd(others.map((e) => nz(e.backLead)));
  let maxRivalLeaderNige = 0;
  for (const e of others)
    if (e.linePos === "先頭" && e.lineGroup !== h.lineGroup) maxRivalLeaderNige = Math.max(maxRivalLeaderNige, nz(e.nige));
  return {
    h, others, lineSize, nLines: lineSize.size, poolRank,
    tokMean, tokSd: Math.max(tokSd, 1), tokMax: toks.length ? Math.max(...toks) : 0,
    scMean, scSd: Math.max(scSd, 1), stMean, stSd: Math.max(stSd, 1), blMean, blSd: Math.max(blSd, 1),
    hMakuriGtNige: nz(h.makuri) > nz(h.nige) ? 1 : 0,
    hIsLeader: h.linePos === "先頭" ? 1 : 0,
    maxRivalLeaderNige,
    girls: r.girls,
  };
}

/** 候補cの「◎との関係」＋個人特性。2着・3着の両ステージ共通部分。 */
const BASE_FEATURES = [
  "sameBehind1", // ◎と同ラインで◎の直後（◎先頭なら番手）
  "sameFront", // ◎と同ラインで◎より前（◎が番手以降のとき）
  "sameFar", // ◎と同ラインで2つ以上後ろ
  "behind1_hMakuri", // sameBehind1 × ◎のまくり>逃げ
  "behind1_rivalNige4", // sameBehind1 × 他ライン先頭のnige最大>=4
  "behind1_markShare", // sameBehind1 × 本人のマーク率
  "behind1_hNotLeader", // sameBehind1 × ◎が先頭でない
  "rivalLeader", // 他ラインの先頭
  "rivalLeader_hMakuri", // 他ライン先頭 × ◎のまくり>逃げ
  "rivalSecond", // 他ラインの番手
  "tanki", // 単騎（男子のみ）
  "tokZ", // 平均得点（非◎内z）
  "tokTop", // 非◎内で平均得点1位
  "scoreZ", // totalScore（非◎内z）
  "poolTop", // honmeiPool[0]
  "poolLogRank", // log(1+honmeiPool順位)
  "kyakuNige",
  "kyakuRyo",
  "nigeShare",
  "makuriShare",
  "markShare",
  "ren3",
  "ren2",
  "standingZ",
  "backLeadZ",
] as const;
const THIRD_EXTRA = [
  "sameAs2nd", // 2着と同ライン
  "behind2nd1", // 2着の直後
  "front2nd", // 2着より前（2着が差した相手）
  "sameAs2nd_and2ndSameH", // ◎・2着・本人が全員同ライン（ライン3車独占）
] as const;

function baseFeat(c: CEntry, x: Ctx): number[] {
  const same = !x.girls && x.h.lineGroup != null && c.lineGroup === x.h.lineGroup;
  const ph = POS[x.h.linePos ?? ""] ?? 1;
  const pc = POS[c.linePos ?? ""] ?? 1;
  const behind1 = same && pc === ph + 1 ? 1 : 0;
  const front = same && pc < ph ? 1 : 0;
  const far = same && pc >= ph + 2 ? 1 : 0;
  const ls = c.lineGroup != null ? x.lineSize.get(c.lineGroup) ?? 1 : 1;
  const tanki = !x.girls && ls === 1 ? 1 : 0;
  const rivalLeader = !x.girls && !same && ls >= 2 && c.linePos === "先頭" ? 1 : 0;
  const rivalSecond = !x.girls && !same && c.linePos === "番手" ? 1 : 0;
  const tok = c.tokuten ?? x.tokMean;
  const k = kimShares(c);
  const pr = x.poolRank.get(c.car) ?? 8;
  return [
    behind1,
    front,
    far,
    behind1 * x.hMakuriGtNige,
    behind1 * (x.maxRivalLeaderNige >= 4 ? 1 : 0),
    behind1 * k.mark,
    behind1 * (1 - x.hIsLeader),
    rivalLeader,
    rivalLeader * x.hMakuriGtNige,
    rivalSecond,
    tanki,
    (tok - x.tokMean) / x.tokSd,
    c.tokuten != null && c.tokuten >= x.tokMax ? 1 : 0,
    (c.totalScore - x.scMean) / x.scSd,
    pr === 0 ? 1 : 0,
    Math.log(1 + pr),
    c.kyaku === "逃" ? 1 : 0,
    c.kyaku === "両" ? 1 : 0,
    k.nige,
    k.makuri,
    k.mark,
    nz(c.ren3) / 100,
    nz(c.ren2) / 100,
    (nz(c.standing) - x.stMean) / x.stSd,
    (nz(c.backLead) - x.blMean) / x.blSd,
  ];
}
function thirdFeat(c: CEntry, s: CEntry, x: Ctx): number[] {
  const same2 = !x.girls && s.lineGroup != null && c.lineGroup === s.lineGroup;
  const ps = POS[s.linePos ?? ""] ?? 1;
  const pc = POS[c.linePos ?? ""] ?? 1;
  const sSameH = !x.girls && x.h.lineGroup != null && s.lineGroup === x.h.lineGroup;
  return [
    ...baseFeat(c, x),
    same2 ? 1 : 0,
    same2 && pc === ps + 1 ? 1 : 0,
    same2 && pc < ps ? 1 : 0,
    same2 && sSameH ? 1 : 0,
  ];
}

// ---------------------------------------------------------------- conditional logit
/** 1グループ = 候補の特徴行列と正解インデックス */
interface Group {
  X: number[][];
  y: number;
}
function softmax(X: number[][], w: number[]): number[] {
  const u = X.map((row) => row.reduce((a, v, i) => a + v * w[i], 0));
  const m = Math.max(...u);
  const e = u.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
/** ニュートン法（L2ペナルティlambda）。勾配不要のライブラリ無しで十分速い。 */
function fit(groups: Group[], dim: number, lambda = 2): number[] {
  let w = new Array(dim).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(dim).fill(0);
    const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
    for (const { X, y } of groups) {
      const p = softmax(X, w);
      const xbar = new Array(dim).fill(0);
      for (let j = 0; j < X.length; j++) for (let i = 0; i < dim; i++) xbar[i] += p[j] * X[j][i];
      for (let i = 0; i < dim; i++) g[i] += X[y][i] - xbar[i];
      for (let j = 0; j < X.length; j++) {
        const d = X[j].map((v, i) => v - xbar[i]);
        for (let a = 0; a < dim; a++) {
          if (d[a] === 0) continue;
          const pa = p[j] * d[a];
          for (let b = a; b < dim; b++) H[a][b] += pa * d[b];
        }
      }
    }
    for (let a = 0; a < dim; a++) {
      g[a] -= lambda * w[a];
      H[a][a] += lambda;
      for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    }
    const step = solve(H, g);
    w = w.map((v, i) => v + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return w;
}
function logLoss(groups: Group[], w: number[]): number {
  let s = 0;
  for (const { X, y } of groups) s -= Math.log(Math.max(1e-12, softmax(X, w)[y]));
  return s / groups.length;
}

// ---------------------------------------------------------------- dataset
interface Sample {
  r: CRace;
  x: Ctx;
  cands: CEntry[];
  second: number; // index in cands
  third: number;
}
function samples(races: CRace[]): Sample[] {
  const out: Sample[] = [];
  for (const r of races) {
    if (r.deadHeat || r.entries.length < 3) continue;
    const [a, b, c] = r.actual.split("-").map(Number);
    if (a !== r.entries[0].car) continue;
    const x = buildCtx(r);
    const cands = x.others;
    const si = cands.findIndex((e) => e.car === b);
    const ti = cands.findIndex((e) => e.car === c);
    if (si < 0 || ti < 0) continue;
    out.push({ r, x, cands, second: si, third: ti });
  }
  return out;
}
const secondGroups = (S: Sample[]): Group[] => S.map((s) => ({ X: s.cands.map((c) => baseFeat(c, s.x)), y: s.second }));
function thirdGroups(S: Sample[]): Group[] {
  return S.map((s) => {
    const sec = s.cands[s.second];
    const rest = s.cands.filter((_, i) => i !== s.second);
    return { X: rest.map((c) => thirdFeat(c, sec, s.x)), y: rest.findIndex((c) => c === s.cands[s.third]) };
  });
}

// ---------------------------------------------------------------- rank-only baselines (calibrated via one-hot rank logit)
type Order = (s: Sample) => number[]; // candidate car order
const poolOrder: Order = (s) => s.r.honmeiPool.filter((c) => s.cands.some((e) => e.car === c));
const scoreOrder: Order = (s) => [...s.cands].sort((a, b) => b.totalScore - a.totalScore).map((e) => e.car);
const tokOrder: Order = (s) =>
  [...s.cands].sort((a, b) => nz(b.tokuten) - nz(a.tokuten) || b.totalScore - a.totalScore).map((e) => e.car);
const RANK_DIM = 8;
function rankX(order: number[], cars: number[]): number[][] {
  return cars.map((car) => {
    const v = new Array(RANK_DIM).fill(0);
    const r = order.indexOf(car);
    v[Math.min(r < 0 ? RANK_DIM - 1 : r, RANK_DIM - 1)] = 1;
    return v;
  });
}

// ---------------------------------------------------------------- pair distributions
type PairDist = { pair: [number, number]; p: number }[];
function modelPairs(s: Sample, w2: number[], w3: number[]): PairDist {
  const p2 = softmax(s.cands.map((c) => baseFeat(c, s.x)), w2);
  const out: PairDist = [];
  s.cands.forEach((sec, j) => {
    const rest = s.cands.filter((_, i) => i !== j);
    const p3 = softmax(rest.map((c) => thirdFeat(c, sec, s.x)), w3);
    rest.forEach((t, k) => out.push({ pair: [sec.car, t.car], p: p2[j] * p3[k] }));
  });
  return out.sort((a, b) => b.p - a.p);
}
/** 順位リスト由来のペア：rank-only logit（2着・3着それぞれtrainでfit）でPLの確率を計算。 */
function orderPairs(s: Sample, order: Order, w2r: number[], w3r: number[]): PairDist {
  const ord = order(s);
  const cars = s.cands.map((c) => c.car);
  const p2 = softmax(rankX(ord, cars), w2r);
  const out: PairDist = [];
  cars.forEach((sec, j) => {
    const restCars = cars.filter((_, i) => i !== j);
    const restOrd = ord.filter((c) => c !== sec);
    const p3 = softmax(rankX(restOrd, restCars), w3r);
    restCars.forEach((t, k) => out.push({ pair: [sec, t], p: p2[j] * p3[k] }));
  });
  return out.sort((a, b) => b.p - a.p);
}
function rankGroups(S: Sample[], order: Order): [Group[], Group[]] {
  const g2: Group[] = [], g3: Group[] = [];
  for (const s of S) {
    const ord = order(s);
    const cars = s.cands.map((c) => c.car);
    g2.push({ X: rankX(ord, cars), y: s.second });
    const sec = cars[s.second];
    const restCars = cars.filter((c) => c !== sec);
    g3.push({ X: rankX(ord.filter((c) => c !== sec), restCars), y: restCars.indexOf(cars[s.third]) });
  }
  return [g2, g3];
}

// ---------------------------------------------------------------- metrics
const KS = [1, 2, 3, 4, 6, 10];
interface Metrics {
  n: number;
  top1: number;
  top2: number;
  top3: number;
  pairK: number[];
  ll2: number;
  llPair: number;
}
function metrics(S: Sample[], second: (s: Sample) => { car: number; p: number }[], pairs: (s: Sample) => PairDist): Metrics {
  const m: Metrics = { n: S.length, top1: 0, top2: 0, top3: 0, pairK: KS.map(() => 0), ll2: 0, llPair: 0 };
  for (const s of S) {
    const sc = s.cands[s.second].car, tc = s.cands[s.third].car;
    const p2 = second(s).sort((a, b) => b.p - a.p);
    const r2 = p2.findIndex((e) => e.car === sc);
    if (r2 < 1) m.top1++;
    if (r2 < 2) m.top2++;
    if (r2 < 3) m.top3++;
    m.ll2 -= Math.log(Math.max(1e-12, p2[r2].p));
    const pd = pairs(s);
    const rp = pd.findIndex((e) => e.pair[0] === sc && e.pair[1] === tc);
    KS.forEach((k, i) => (rp < k ? m.pairK[i]++ : 0));
    m.llPair -= Math.log(Math.max(1e-12, pd[rp].p));
  }
  const n = Math.max(1, S.length);
  return { ...m, top1: m.top1 / n, top2: m.top2 / n, top3: m.top3 / n, pairK: m.pairK.map((v) => v / n), ll2: m.ll2 / n, llPair: m.llPair / n };
}
const pct = (v: number) => (v * 100).toFixed(1).padStart(5);
function printMetrics(label: string, m: Metrics) {
  console.log(
    `  ${label.padEnd(16)} n=${String(m.n).padStart(4)} 2着top1 ${pct(m.top1)} top2 ${pct(m.top2)} top3 ${pct(m.top3)} | ` +
      `pair@K ${m.pairK.map(pct).join(" ")} | LL2 ${m.ll2.toFixed(3)} LLpair ${m.llPair.toFixed(3)}`
  );
}

// ---------------------------------------------------------------- main
const all = loadCache();
const SEG = (girls: boolean) => samples(all.filter((r) => r.girls === girls));
const out: Record<string, unknown> = {
  description:
    "P(2着=j | ◎1着) と P(3着=k | ◎1着, 2着=j) の条件付きロジット（逐次softmax/Plackett-Luce型）。" +
    "候補=entries[1..]全員。features はscripts/research/second-third-model.tsのbaseFeat/thirdFeat参照。",
  trainCut: `date < ${CUT}`,
  models: {},
};
const fitted: Record<string, { w2: number[]; w3: number[]; r: Record<string, [number[], number[]]> }> = {};

for (const girls of [false, true]) {
  const seg = girls ? "girls" : "men";
  const S = SEG(girls);
  const tr = S.filter((s) => s.r.date < CUT);
  const te = S.filter((s) => s.r.date >= CUT);
  console.log(`\n===== ${seg}: ◎1着サンプル train ${tr.length} / test ${te.length}（平均候補 ${(S.reduce((a, s) => a + s.cands.length, 0) / S.length).toFixed(2)}人）`);
  const g2tr = secondGroups(tr), g3tr = thirdGroups(tr);
  const w2 = fit(g2tr, BASE_FEATURES.length);
  const w3 = fit(g3tr, BASE_FEATURES.length + THIRD_EXTRA.length);
  const rk: Record<string, [number[], number[]]> = {};
  const orders: Record<string, Order> = { pool: poolOrder, totalScore: scoreOrder, tokuten: tokOrder };
  for (const [k, o] of Object.entries(orders)) {
    const [a, b] = rankGroups(tr, o);
    rk[k] = [fit(a, RANK_DIM, 0.5), fit(b, RANK_DIM, 0.5)];
  }
  fitted[seg] = { w2, w3, r: rk };
  console.log("  2着モデル係数:");
  BASE_FEATURES.forEach((f, i) => console.log(`    ${f.padEnd(22)} ${w2[i].toFixed(3)}`));
  console.log("  3着モデル係数:");
  [...BASE_FEATURES, ...THIRD_EXTRA].forEach((f, i) => console.log(`    ${f.padEnd(22)} ${w3[i].toFixed(3)}`));
  (out.models as Record<string, unknown>)[seg] = {
    secondFeatures: BASE_FEATURES,
    second: Object.fromEntries(BASE_FEATURES.map((f, i) => [f, +w2[i].toFixed(5)])),
    thirdFeatures: [...BASE_FEATURES, ...THIRD_EXTRA],
    third: Object.fromEntries([...BASE_FEATURES, ...THIRD_EXTRA].map((f, i) => [f, +w3[i].toFixed(5)])),
    trainSamples: tr.length,
  };
}

function evalSet(label: string, S: Sample[], seg: string) {
  const { w2, w3, r } = fitted[seg];
  console.log(`\n[${label}]`);
  const modelSecond = (s: Sample) => softmax(s.cands.map((c) => baseFeat(c, s.x)), w2).map((p, i) => ({ car: s.cands[i].car, p }));
  printMetrics("model", metrics(S, modelSecond, (s) => modelPairs(s, w2, w3)));
  for (const [k, o] of Object.entries({ pool: poolOrder, totalScore: scoreOrder, tokuten: tokOrder })) {
    const [a, b] = r[k];
    const sec = (s: Sample) => softmax(rankX(o(s), s.cands.map((c) => c.car)), a).map((p, i) => ({ car: s.cands[i].car, p }));
    printMetrics(`${k}順(現行=pool)`.slice(0, 16), metrics(S, sec, (s) => orderPairs(s, o, a, b)));
  }
}
function calib(S: Sample[], seg: string) {
  const { w2, w3 } = fitted[seg];
  const pts: [number, number][] = [];
  const pairPts: [number, number][] = [];
  for (const s of S) {
    softmax(s.cands.map((c) => baseFeat(c, s.x)), w2).forEach((p, i) => pts.push([p, i === s.second ? 1 : 0]));
    const pd = modelPairs(s, w2, w3);
    const sc = s.cands[s.second].car, tc = s.cands[s.third].car;
    for (const e of pd.slice(0, 10)) pairPts.push([e.p, e.pair[0] === sc && e.pair[1] === tc ? 1 : 0]);
  }
  const show = (name: string, P: [number, number][]) => {
    P.sort((a, b) => a[0] - b[0]);
    const rows: string[] = [];
    for (let d = 0; d < 10; d++) {
      const sl = P.slice(Math.floor((d * P.length) / 10), Math.floor(((d + 1) * P.length) / 10));
      const mp = sl.reduce((a, b) => a + b[0], 0) / sl.length;
      const ma = sl.reduce((a, b) => a + b[1], 0) / sl.length;
      rows.push(`${(mp * 100).toFixed(1)}→${(ma * 100).toFixed(1)}`);
    }
    console.log(`  ${name}（予測%→実績%, 10分位）: ${rows.join(" | ")}`);
  };
  show("2着確率", pts);
  show("ペア確率(各レース上位10組)", pairPts);
}

const gensenIds = new Set(selectGensen(all).map((r) => r.raceId));
for (const seg of ["men", "girls"]) {
  const S = SEG(seg === "girls");
  const tr = S.filter((s) => s.r.date < CUT);
  const te = S.filter((s) => s.r.date >= CUT);
  evalSet(`${seg} TRAIN ◎1着全レース`, tr, seg);
  evalSet(`${seg} TEST ◎1着全レース`, te, seg);
  console.log(`\n[${seg} TEST キャリブレーション]`);
  calib(te, seg);
  if (seg === "men") {
    evalSet(`厳選 TRAIN（◎1着分）`, tr.filter((s) => gensenIds.has(s.r.raceId)), seg);
    evalSet(`厳選 TEST（◎1着分）`, te.filter((s) => gensenIds.has(s.r.raceId)), seg);
    evalSet(`バリカタ候補 TRAIN（◎1着分）`, tr.filter((s) => isBarikataCandidate(s.r)), seg);
    evalSet(`バリカタ候補 TEST（◎1着分）`, te.filter((s) => isBarikataCandidate(s.r)), seg);
  }
}

// ---------------------------------------------------------------- strategy-level checks (全レース母数、◎が負けたレースも含む)
function topPairsFor(r: CRace, n: number): string[] {
  const x = buildCtx(r);
  const seg = r.girls ? "girls" : "men";
  const { w2, w3 } = fitted[seg];
  const s: Sample = { r, x, cands: x.others, second: 0, third: 1 };
  return modelPairs(s, w2, w3).slice(0, n).map((e) => `${r.entries[0].car}-${e.pair[0]}-${e.pair[1]}`);
}
function hitStats(label: string, races: CRace[], fn: (r: CRace) => string[]) {
  let n = 0, hit = 0, pts = 0, pay = 0, payN = 0, stake = 0;
  for (const r of races) {
    if (r.deadHeat) continue;
    const cs = fn(r);
    if (!cs.length) continue;
    n++;
    pts += cs.length;
    const h = cs.includes(r.actual);
    if (h) hit++;
    if (r.hasOdds) {
      payN++;
      stake += cs.length * 100;
      if (h && r.payout != null) pay += r.payout;
    }
  }
  console.log(
    `  ${label.padEnd(30)} n=${n} 点数${(pts / Math.max(1, n)).toFixed(1)} 的中${pct(hit / Math.max(1, n))}% (${hit}) 回収${pct(pay / Math.max(1, stake))}% [odds有${payN}]`
  );
}
const bari = all.filter(isBarikataCandidate);
for (const [nm, set] of [
  ["TRAIN", bari.filter((r) => r.date < CUT)],
  ["TEST", bari.filter((r) => r.date >= CUT)],
] as const) {
  console.log(`\n[バリカタ 1点 ${nm}（全候補レース、◎負けも母数）]`);
  hitStats("現行 currentBarikataCombo", set, (r) => [currentBarikataCombo(r)]);
  hitStats("モデル top1ペア", set, (r) => topPairsFor(r, 1));
}
const gensen = selectGensen(all);
for (const [nm, set] of [
  ["TRAIN", gensen.filter((r) => r.date < CUT)],
  ["TEST", gensen.filter((r) => r.date >= CUT)],
] as const) {
  console.log(`\n[厳選 ${nm}：現行買い目 vs 同点数のモデル上位ペア]`);
  hitStats("現行 本命シナリオ", set, honmeiCombos);
  hitStats("モデル 同点数", set, (r) => topPairsFor(r, honmeiCombos(r).length));
}

writeFileSync(path.join(process.cwd(), "scripts", "data", "second-third-model.json"), JSON.stringify(out, null, 2));
console.log("\nsaved scripts/data/second-third-model.json");

// ---------------------------------------------------------------- ablations（男子・test）：ルックアヘッド耐性と移植用の軽量版の確認
{
  const S = SEG(false);
  const tr = S.filter((s) => s.r.date < CUT);
  const te = S.filter((s) => s.r.date >= CUT);
  const ALL3 = [...BASE_FEATURES, ...THIRD_EXTRA] as readonly string[];
  const mask = (G: Group[], names: readonly string[], keep: (f: string) => boolean): Group[] =>
    G.map((g) => ({ y: g.y, X: g.X.map((row) => row.map((v, i) => (keep(names[i]) ? v : 0))) }));
  const variants: [string, (f: string) => boolean][] = [
    ["full", () => true],
    ["no ren2/ren3", (f) => f !== "ren2" && f !== "ren3"],
    ["no snapshot stats(ren/kimarite/standing/backLead/tokuten)", (f) => !/ren|Share|standing|backLead|tok|kyaku/.test(f)],
    ["lines+tokZ+scoreZ only", (f) => /^same|^rival|tanki|tokZ|scoreZ|2nd/.test(f) && !/_/.test(f.replace("sameAs2nd_and2ndSameH", "x"))],
  ];
  console.log("\n[男子 ablation：test]");
  for (const [nm, keep] of variants) {
    const g2 = mask(secondGroups(tr), BASE_FEATURES, keep), g3 = mask(thirdGroups(tr), ALL3, keep);
    const w2 = fit(g2, BASE_FEATURES.length), w3 = fit(g3, ALL3.length);
    const kept2 = BASE_FEATURES.filter(keep);
    const sec = (s: Sample) => softmax(s.cands.map((c) => baseFeat(c, s.x).map((v, i) => (keep(BASE_FEATURES[i]) ? v : 0))), w2).map((p, i) => ({ car: s.cands[i].car, p }));
    printMetrics(nm.slice(0, 16), metrics(te, sec, (s) => modelPairs(s, w2, w3)));
    if (nm.startsWith("lines")) console.log("    lean 2nd:", kept2.map((f) => `${f}=${w2[BASE_FEATURES.indexOf(f as never)].toFixed(2)}`).join(" "));
  }
}
