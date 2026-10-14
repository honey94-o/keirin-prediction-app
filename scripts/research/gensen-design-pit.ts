/**
 * 【検証結果: 厳選の買い方は「margin>=10・PITモデル上位1点（E）」が P2/P3 両方で ex1 81%/114%、
 *   P2+P3 ex1 111% ex3 91% CI[90,186]。現行(A)は P2+P3 回収152%だが ex1 70%（1件の高配当頼み）。
 *   margin16+ はP2・P3ともどの買い方も ex1<56%で外して良い。13-16はtop1だけ ex1 101%(n=32)で判定不能。
 *   いずれの案も ex3>100% や CI下限>100% には届かない（n=94〜141）】
 *
 * 男子の2・3着順はリーク無しPITモデル（pit-model.ts、walk-forward：P2=P1で学習、P3=P1+P2で学習、
 * P1はP2+P3で学習した逆向き＝参考）。ガールズは現行honmeiPool順。厳選の選定は selectGensen
 * （raceStage修正後のisGensenCandidate）。odds有りレースのみ、100円/点。
 * 整合チェック：P3 男子 2着top1 52.1 / pair@1 25.5（second-third-model-pit.tsと一致）。
 *
 * ■ 1. margin帯 × 買い方（ex1、的中/レース）           P2            P3            P2+P3
 *   10-13 現行            46% 20/45   68% 26/49   70% 46/94
 *         top1/2/3/4/6    57/60/93/94/119%   126/78/83/86/67%   111/83/97/96/97%
 *   13-16 現行            68% 5/12    56% 6/20    71% 11/32
 *         top1/2/3/4/6    111/75/126/94/63%  57/48/57/43/29%    101/70/92/69/46%
 *   16+   現行            37% 3/8     17% 2/7     39% 5/15
 *         top1/2/3/4/6    31/16/25/18/12%    34/17/11/9/14%     55/28/26/20/19%
 *   → 16+はどの買い方でも両期間大敗＝除外妥当。13-16はP3で全買い方負け、P2はn=12で数件依存。
 *
 * ■ 2. 日次シミュレーション（P2+P3：開催102日）
 *   案                       n   件/日 点  的中 回収  ex1  ex3  収支      | P2 ex1 | P3 ex1
 *   A 現行                   141 1.38 7.2  62  152%  70%  55%  +52,560円 |  50%   |  68%
 *   B m>=10 top4             141 1.38 4.0  60   92%  87%  77%   −4,330円 |  94%   |  72%
 *   C m10-13 top4             94 0.92 4.0  39  105%  96%  82%   +1,900円 |  94%   |  86%
 *   D m10-13 topK(wf, K=6)    94 0.92 6.0  47  116%  97%  82%   +8,850円 | 119%   |  67%
 *   E m>=10 top1             141 1.38 1.0  34  134% 111%  91%   +4,800円 |  81%   | 114%
 *   （D は P1でもP1+P2でもK=6が選ばれ、P3で崩れた。Aの+52,560円はP3の1件の大穴が大半）
 *
 * ■ 3. バリカタ（raceStage非依存の確認）：現行並び vs モデルtop1 = P2 24→26/76、P3 33→36/99、
 *   P2+P3 57→62/175（ex1 119%→126%）。前回と同じ（n差1は同着レースを含めたため）。
 *
 * 実行: npx tsx scripts/research/gensen-design-pit.ts   （本番DBには接続しない）
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  loadCache,
  selectGensen,
  isGensenCandidate,
  isBarikataCandidate,
  currentBarikataCombo,
  honmeiCombos,
  type CRace,
} from "../lib/research-cache";
import {
  computeForm,
  buildRaceCtx,
  secondFeatureVector,
  thirdFeatureVector,
  pairProbabilities,
  softmax,
  SECOND_FEATURES,
  THIRD_FEATURES,
  type PitRecord,
  type PitEntry,
  type PitForm,
  type PitCoefs,
  type PosCat,
} from "./pit-model";

const P2_START = "20260615";
const P3_START = "20260726";
const HIST_WARM_CUTOFF = "20260405";
const ROOT = process.cwd();
const modelJson = JSON.parse(readFileSync(path.join(ROOT, "scripts", "data", "second-third-model-pit.json"), "utf-8"));
const priors = modelJson.priors;
const K = modelJson.shrinkageK;

// ================================================================ 時点履歴（pit-model.tsの入力仕様どおり）
const db = new DatabaseSync(path.join(ROOT, "scripts", "data", "local.sqlite"), { readOnly: true });
const ent = db.prepare(`select race_id rid, car_num car, line_group lg, line_position lp from entries`).all() as { rid: number; car: number; lg: number | null; lp: string | null }[];
const lgSize = new Map<string, number>();
for (const e of ent) if (e.lg != null) lgSize.set(`${e.rid}:${e.lg}`, (lgSize.get(`${e.rid}:${e.lg}`) ?? 0) + 1);
const entMap = new Map(ent.map((e) => [`${e.rid}:${e.car}`, e]));
const res = db
  .prepare(`select x.race_id rid, r.kaisai_date d, x.snum, x.car_num car, x.finish_pos f, x.kimarite k from results x join races r on r.id=x.race_id where x.finish_pos is not null`)
  .all() as { rid: number; d: string; snum: string; car: number; f: number; k: string | null }[];
const fieldSize = new Map<number, number>();
for (const r of res) fieldSize.set(r.rid, (fieldSize.get(r.rid) ?? 0) + 1);
const hist = new Map<string, PitRecord[]>();
const add = (s: string, r: PitRecord) => {
  let a = hist.get(s);
  if (!a) hist.set(s, (a = []));
  a.push(r);
};
for (const r of res) {
  const e = entMap.get(`${r.rid}:${r.car}`);
  let posCat: PosCat | null = null;
  if (e) {
    const n = e.lg != null ? lgSize.get(`${r.rid}:${e.lg}`) ?? 1 : 1;
    posCat = n <= 1 ? "K" : e.lp === "先頭" ? "L" : e.lp === "番手" ? "S" : "T";
  }
  add(r.snum, { date: r.d, finishPos: r.f, fieldSize: fieldSize.get(r.rid)!, posCat, kimarite: r.k });
}
// 研究用warm-start（second-third-model-pit.tsと同じ）
for (const h of db
  .prepare(`select snum, race_date_full d, finish_positions fp, scraped_at sa from racer_race_history where race_date_full is not null and race_date_full <= ?`)
  .all(HIST_WARM_CUTOFF) as { snum: string; d: string; fp: string; sa: string }[]) {
  if (h.d > h.sa.slice(0, 10).replace(/-/g, "")) continue;
  const base = Date.UTC(+h.d.slice(0, 4), +h.d.slice(4, 6) - 1, +h.d.slice(6, 8));
  (h.fp ?? "").split(",").forEach((tok, i) => {
    const t = tok.trim();
    if (!t || t.startsWith("欠")) return;
    const m = /^(\d+)/.exec(t);
    add(h.snum, { date: new Date(base + i * 86400000).toISOString().slice(0, 10).replace(/-/g, ""), finishPos: m ? +m[1] : 9, fieldSize: 7, posCat: null, kimarite: null });
  });
}
const formCache = new Map<string, PitForm>();
const formOf = (snum: string, date: string) => {
  const key = `${snum}:${date}`;
  let f = formCache.get(key);
  if (!f) formCache.set(key, (f = computeForm(hist.get(snum) ?? [], date, priors, K)));
  return f;
};
const entriesOf = (r: CRace): PitEntry[] => r.entries.map((e) => ({ car: e.car, lineGroup: e.lineGroup, linePos: e.linePos, form: formOf(e.snum, r.date) }));

// ================================================================ fit（Newton + L2=2、前回と同じ）
interface Group { X: number[][]; y: number }
const sm = (X: number[][], w: number[]) => softmax(X.map((row) => row.reduce((a, v, i) => a + v * w[i], 0)));
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
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
function fit(groups: Group[], dim: number, lambda = 2): number[] {
  let w = new Array(dim).fill(0);
  for (let it = 0; it < 40; it++) {
    const g = new Array(dim).fill(0);
    const H = Array.from({ length: dim }, () => new Array(dim).fill(0));
    for (const { X, y } of groups) {
      const p = sm(X, w);
      const xbar = new Array(dim).fill(0);
      for (let j = 0; j < X.length; j++) for (let i = 0; i < dim; i++) xbar[i] += p[j] * X[j][i];
      for (let i = 0; i < dim; i++) g[i] += X[y][i] - xbar[i];
      for (let j = 0; j < X.length; j++) {
        const d = X[j].map((v, i) => v - xbar[i]);
        for (let a = 0; a < dim; a++) {
          if (!d[a]) continue;
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
interface Sample { r: CRace; si: number; ti: number; pe: PitEntry[] }
function samples(races: CRace[]): Sample[] {
  const out: Sample[] = [];
  for (const r of races) {
    if (r.deadHeat || r.entries.length < 3) continue;
    const [a, b, c] = r.actual.split("-").map(Number);
    if (a !== r.entries[0].car) continue;
    const others = r.entries.slice(1);
    const si = others.findIndex((e) => e.car === b), ti = others.findIndex((e) => e.car === c);
    if (si < 0 || ti < 0) continue;
    out.push({ r, si, ti, pe: entriesOf(r) });
  }
  return out;
}
function fitCoefs(S: Sample[]): PitCoefs {
  const g2: Group[] = [], g3: Group[] = [];
  for (const s of S) {
    const x = buildRaceCtx(s.pe, s.r.entries[0].car, s.r.girls);
    g2.push({ X: x.others.map((c) => secondFeatureVector(c, x)), y: s.si });
    const sec = x.others[s.si];
    const rest = x.others.filter((_, i) => i !== s.si);
    g3.push({ X: rest.map((c) => thirdFeatureVector(c, sec, x)), y: rest.indexOf(x.others[s.ti]) });
  }
  const w2 = fit(g2, SECOND_FEATURES.length), w3 = fit(g3, THIRD_FEATURES.length);
  return {
    second: Object.fromEntries(SECOND_FEATURES.map((f, i) => [f, w2[i]])),
    third: Object.fromEntries(THIRD_FEATURES.map((f, i) => [f, w3[i]])),
  };
}

// ================================================================ walk-forward モデル（男子のみ）
type Period = "P1" | "P2" | "P3";
const period = (d: string): Period => (d < P2_START ? "P1" : d < P3_START ? "P2" : "P3");
const all = loadCache();
const menS = samples(all.filter((r) => !r.girls));
const coefs: Record<Period, PitCoefs> = {
  P1: fitCoefs(menS.filter((s) => s.r.date >= P2_START)), // 逆向き（参考）
  P2: fitCoefs(menS.filter((s) => s.r.date < P2_START)),
  P3: fitCoefs(menS.filter((s) => s.r.date < P3_START)),
};
// D案のK選択用：その期間の学習データに対するin-sample予測（未来を見ない）
const coefsInSampleP1 = coefs.P2; // P1で学習 → P1上でK選択（P2用）
const coefsInSampleP12 = coefs.P3; // P1+P2で学習 → P1+P2上でK選択（P3用）

// 整合チェック：P3のwalk-forward指標が second-third-model-pit.ts（52.1 / pair@1 25.5）と一致するか
{
  const te = menS.filter((s) => period(s.r.date) === "P3");
  let t1 = 0, p1 = 0;
  for (const s of te) {
    const pp = pairProbabilities(s.pe, s.r.entries[0].car, coefs.P3, { girls: false });
    const sc = s.r.entries[1 + s.si].car, tc = s.r.entries[1 + s.ti].car;
    const m2 = new Map<number, number>();
    for (const e of pp) m2.set(e.second, (m2.get(e.second) ?? 0) + e.p);
    const top2 = [...m2.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (top2 === sc) t1++;
    if (pp[0].second === sc && pp[0].third === tc) p1++;
  }
  console.log(`整合チェック P3 男子: 2着top1 ${((t1 / te.length) * 100).toFixed(1)} pair@1 ${((p1 / te.length) * 100).toFixed(1)} (n=${te.length})`);
}

const pairCache = new Map<string, string[]>();
/** 男子＝PITモデル上位K、ガールズ＝現行honmeiPool順から（pool[0]-pool[1], pool[0]-pool[2], pool[1]-pool[0], ...の辞書順でなく順位和順） */
function topK(r: CRace, k: number, c: PitCoefs, tag: string): string[] {
  const key = `${r.raceId}:${tag}`;
  let all6 = pairCache.get(key);
  if (!all6) {
    const h = r.entries[0].car;
    if (r.girls) {
      const pool = r.honmeiPool.filter((x) => x !== h);
      const pairs: [number, number, number][] = [];
      pool.forEach((a, i) => pool.forEach((b, j) => (i !== j ? pairs.push([a, b, i + j + i * 0.1]) : 0)));
      all6 = pairs.sort((x, y) => x[2] - y[2]).map(([a, b]) => `${h}-${a}-${b}`);
    } else {
      all6 = pairProbabilities(entriesOf(r), h, c, { girls: false }).map((e) => `${h}-${e.second}-${e.third}`);
    }
    pairCache.set(key, all6);
  }
  return all6.slice(0, k);
}
const wfTop = (k: number) => (r: CRace) => topK(r, k, coefs[period(r.date)], period(r.date));

// ================================================================ 集計
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Fn = (r: CRace) => string[];
interface Agg { n: number; points: number; hits: number; stake: number; ret: number; hitPays: number[]; per: { s: number; p: number }[] }
function agg(races: CRace[], fn: Fn): Agg {
  const a: Agg = { n: 0, points: 0, hits: 0, stake: 0, ret: 0, hitPays: [], per: [] };
  for (const r of races) {
    if (!r.hasOdds) continue;
    const c = fn(r);
    if (!c.length) continue;
    a.n++;
    a.points += c.length;
    a.stake += c.length * 100;
    let p = 0;
    if (c.includes(r.actual) && r.payout != null) {
      a.hits++;
      p = r.payout;
      a.hitPays.push(p);
    }
    a.ret += p;
    a.per.push({ s: c.length * 100, p });
  }
  a.hitPays.sort((x, y) => y - x);
  return a;
}
const roi = (a: Agg) => (a.stake ? a.ret / a.stake : 0);
const exTop = (a: Agg, k: number) => (a.stake ? (a.ret - a.hitPays.slice(0, k).reduce((s, x) => s + x, 0)) / a.stake : 0);
function bootCI(a: Agg, iters = 1000): [number, number] {
  if (!a.per.length) return [0, 0];
  const rnd = mulberry32(12345);
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0, p = 0;
    for (let j = 0; j < a.per.length; j++) {
      const x = a.per[(rnd() * a.per.length) | 0];
      s += x.s;
      p += x.p;
    }
    vals.push(p / s);
  }
  vals.sort((x, y) => x - y);
  return [vals[50], vals[949]];
}
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const days: Record<string, number> = { P1: 0, P2: 0, P3: 0 };
for (const d of new Set(all.map((r) => r.date))) days[period(d)]++;
days["P2+P3"] = days.P2 + days.P3;
const PERIODS: [string, (d: string) => boolean][] = [
  ["P1(参考)", (d) => d < P2_START],
  ["P2", (d) => d >= P2_START && d < P3_START],
  ["P3", (d) => d >= P3_START],
  ["P2+P3", (d) => d >= P2_START],
];
function line(label: string, races: CRace[], fn: Fn, pk: string, full = false) {
  const a = agg(races, fn);
  const dk = pk.startsWith("P1") ? "P1" : pk;
  const base = `   ${label.padEnd(28)} ${pk.padEnd(8)} n=${String(a.n).padStart(3)} 的中${String(a.hits).padStart(3)} 回収${pct(roi(a)).padStart(5)} ex1 ${pct(exTop(a, 1)).padStart(4)}`;
  if (!full) return console.log(base);
  const ci = bootCI(a);
  console.log(
    `${base} ex3 ${pct(exTop(a, 3)).padStart(4)} ${(a.n / days[dk]).toFixed(2)}件/日 ${(a.points / Math.max(1, a.n)).toFixed(1)}点 収支${(a.ret - a.stake).toLocaleString().padStart(8)}円 CI[${pct(ci[0])},${pct(ci[1])}]`
  );
}

// ================================================================ 1. margin帯
const gensenAll = selectGensen(all);
console.log(`\n厳選（新raceStage）候補 ${gensenAll.length}R（margin>=10）。うちガールズ ${gensenAll.filter((r) => r.girls).length}R`);
console.log("\n==== 1. margin帯 × 買い方（男子=PITモデル、ガールズ=現行pool順）");
for (const [lo, hi] of [[10, 13], [13, 16], [16, 999]] as const) {
  const band = gensenAll.filter((r) => r.margin >= lo && r.margin < hi);
  console.log(` [margin ${lo}-${hi === 999 ? "" : hi}]`);
  for (const [pk, inP] of PERIODS) {
    const rs = band.filter((r) => inP(r.date));
    line("現行", rs, honmeiCombos, pk);
    for (const k of [1, 2, 3, 4, 6]) line(`モデル top${k}`, rs, wfTop(k), pk);
  }
}

// ================================================================ 2. 日次シミュレーション
const KS = [1, 2, 3, 4, 6];
const m1013 = (r: CRace) => isGensenCandidate(r) && r.margin < 13;
const g1013 = selectGensen(all, m1013);
function chooseK(races: CRace[], c: PitCoefs, tag: string): number {
  let best = KS[0], bv = -1;
  for (const k of KS) {
    const v = exTop(agg(races, (r) => topK(r, k, c, tag)), 1);
    if (v > bv) [best, bv] = [k, v];
  }
  return best;
}
const kFor: Record<Period, number> = {
  P1: chooseK(g1013.filter((r) => r.date < P2_START), coefsInSampleP1, "isP1"),
  P2: chooseK(g1013.filter((r) => r.date < P2_START), coefsInSampleP1, "isP1"),
  P3: chooseK(g1013.filter((r) => r.date < P3_START), coefsInSampleP12, "isP12"),
};
console.log(`\n==== 2. 日次シミュレーション（selectGensen、odds有のみ。D案のK: P2用=${kFor.P2}（P1で選択）, P3用=${kFor.P3}（P1+P2で選択）, P1参考=${kFor.P1}）`);
const designs: [string, CRace[], Fn][] = [
  ["A 現行", gensenAll, honmeiCombos],
  ["B m>=10 top4", gensenAll, wfTop(4)],
  ["C m10-13 top4", g1013, wfTop(4)],
  ["D m10-13 topK(walk-fwd)", g1013, (r) => wfTop(kFor[period(r.date)])(r)],
  ["E m>=10 top1", gensenAll, wfTop(1)],
  ["E' m10-16 top1", selectGensen(all, (r) => isGensenCandidate(r) && r.margin < 16), wfTop(1)],
  ["E'' m10-13 top1", g1013, wfTop(1)],
  ["参考 m10-13 現行", g1013, honmeiCombos],
];
for (const [pk, inP] of PERIODS) {
  console.log(` [${pk}] 開催日${days[pk.startsWith("P1") ? "P1" : pk]}`);
  for (const [nm, rs, fn] of designs) line(nm, rs.filter((r) => inP(r.date)), fn, pk, true);
}

// ================================================================ 3. バリカタ再確認
console.log("\n==== 3. バリカタ1点（isBarikataCandidate、raceStage非依存）");
const bari = all.filter(isBarikataCandidate);
for (const [pk, inP] of PERIODS) {
  const rs = bari.filter((r) => inP(r.date));
  const hit = (fn: Fn) => rs.filter((r) => fn(r).includes(r.actual)).length;
  console.log(`   ${pk.padEnd(8)} n=${rs.length} 現行 ${hit((r) => [currentBarikataCombo(r)])} / モデルtop1 ${hit(wfTop(1))}`);
  line("  現行並び", rs, (r) => [currentBarikataCombo(r)], pk);
  line("  モデルtop1", rs, wfTop(1), pk);
}
