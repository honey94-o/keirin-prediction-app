/**
 * 【検証結果: 男子はリーク除去後もwalk-forward全期間で現行honmeiPool順に勝つ（2着top1 +1.5〜4pt、
 *   pair@1 +1.7〜5pt、LLpair −0.17〜−0.24）。改善はほぼ全部ライン構造の重み付けから来ており、
 *   時点成績(PIT form)の上積みは log-loss とpair@3/6で小さく効くだけ。ガールズは互角〜負け（不採用）。
 *   バリカタはモデルtop1ペアが全3期間で現行並びより的中+2〜7件。厳選10-13はどの買い方もex1が
 *   期間で割れ、全期間100%超えは無し】
 *
 * 前作 second-third-model.ts は racers スナップショット（得点・勝率・連対率・決まり手回数等、
 * 2026-08〜10時点の値＝評価レースより後の成績を含む）と totalScore/honmeiPool順位を特徴量に
 * 使っていた。本スクリプトはそれらを全て外し、(a) その日の並び（entries.line_group/line_position）
 * から作るライン構造、(b) results+races+entries から「開催日より前」だけで計算した時点成績
 * （直近20走の勝率/2連対/3連対/正規化着順、直近5走3連対、120日の位置別2連対・決まり手率・先頭頻度、
 * ベイズ縮約 (x+K·prior)/(n+K)）だけで2段softmaxを再fitした。◎=entries[0]（totalScore1位）は
 * 依然リーク込みだが、◎1着レースに条件付けて2・3着だけを問う。
 * 研究時はDB結果（20260409〜）以前を racer_race_history で補完（--no-warm でも結果はほぼ同じ：
 * P2 top1 51.6 / pair@1 24.5、P3 52.3 / 25.6）。
 *
 * ■ walk-forward（男子 ◎1着、P1<0615 は P2+P3 で学習した逆向き＝参考）
 *   期間         モデル  2着top1 top2 | pair@1  @2   @3   @6  | LL2   LLpair
 *   P2 0615-0725 PIT     51.1  69.7  | 23.9  35.5 44.5 61.1 | 1.389 2.813   (train=P1 1,681件, test 1,136)
 *                構造のみ 51.5  69.1  | 24.9  35.2 42.2 59.9 | 1.412 2.854
 *                成績のみ 27.5  48.4  |  9.1  15.6 22.1 36.0 | 1.725 3.302
 *                現行pool 49.6  64.8  | 22.2  31.4 39.3 57.0 | 1.468 2.978
 *   P3 >=0726    PIT     52.1  69.5  | 25.5  37.0 44.9 61.2 | 1.381 2.780   (train=P1+P2 2,817, test 1,740)
 *                構造のみ 52.5  68.8  | 24.9  35.5 43.0 60.6 | 1.413 2.850
 *                現行pool 50.6  66.4  | 22.2  32.2 40.3 57.9 | 1.450 2.950
 *   P1 <0615     PIT     52.6  69.5  | 27.1  37.5 45.6 61.5 | 1.364 2.747
 *                現行pool 48.2  65.4  | 22.0  29.3 39.3 55.5 | 1.497 2.990
 *   ※前作（リーク込み）P3: 54.9 / pair@1 27.7 / LLpair 2.534 → リーク除去で top1 −2.8pt、pair@1 −2.2pt。
 *     差の大半（2着top1 +1.5〜4pt）は残る。なお現行pool順自体もスナップショット由来の並び替えを含むので
 *     ライブでの差はこれより縮まる理由は無い。
 *   ガールズ（構造特徴なし＝成績のみ）：P2 47.1 vs pool 45.0、P3 38.5 vs 43.2（負け）、P1 38.9 vs 38.6 → 不採用。
 *
 * ■ バリカタ1点（全候補レース母数、的中率 / 件/日 / ex1）
 *                         P1(逆向き)           P2                  P3                  P2+P3
 *   現行条件×現行並び     27/147 18% 2.19 55%  24/75 32% 1.83 100% 33/99 33% 1.62 123% 57/174 33% ex1 119%
 *   現行条件×モデルtop1   34/147 23%      67%  26/75 35%      106% 36/99 36%      131% 62/174 36% ex1 126%
 *   ◎先頭m>=7×現行並び   30/124 24% 1.85 68%  24/74 32% 1.80 106% 31/88 35% 1.44  92% 55/162 34% ex1 109%
 *   ◎先頭m>=7×モデル     37/124 30%      80%  26/74 35%      113% 33/88 38%       98% 59/162 36% ex1 116%
 *   → モデル並びは条件を問わず全期間で+2〜7的中。◎先頭m>=7の選定はP1では効くがP2/P3では
 *     現行条件と的中率がほぼ同じ（件/日はやや減る）。
 *
 * ■ 厳選 margin10-13（selectGensenのうち10<=m<13、ex1回収）
 *                    P1(逆)  P2    P3    P2+P3(ex1/ex3/CI)
 *   現行 本命(~9.8点) 59%    46%   68%   70% / 52% [55,335]
 *   モデル top1       71%    66%  126%  116% / 85% [85,231]
 *   モデル top2       75%    60%   78%   83%
 *   モデル top3       60%    93%   83%   97%
 *   モデル top4       82%    94%   86%   96% / 82% [75,136]
 *   モデル top6      105%   119%   67%   97%
 *   ◎ライン独占除外 top1/2/3/4/6 は P3 で 0/52/47/35/33% と崩れる（P1/P2では top6 107/125%）。
 *   → モデルtop4は全期間で現行のex1を上回るが100%未満。全期間でex1>100%の買い方は無し。
 *     n=45〜57/期間で CI は非常に広い。「安い同ライン決着を外す」案は再現しない。
 *
 * ■ 最終係数（男子・全4,557件fit。3着段は+sameAs2nd 0.21, behind2nd1 1.11, front2nd 0.31, and2ndSameH 0.20）
 *   2着: sameBehind1 1.38, sameFront 1.19, sameFar −0.34, behind1_hNotLeader −0.36, behind1_hNige 0.88,
 *        rivalLeader −0.22, rivalSecond −0.20, rivalThird −1.16, tanki −0.39, car1to3 0.25,
 *        fFin −2.20, fTop2 0.74, fTop3 0.54, fRec3 0.42, fPosTop2 0.46, fLead 0.48, fSashi 0.49 …
 *   保存先 scripts/data/second-third-model-pit.json（特徴定義・縮約priorとK・walk-forward係数込み）。
 *
 * 実行: npx tsx scripts/research/second-third-model-pit.ts [--no-warm]
 * 本番DBには接続しない（scripts/data/local.sqlite と scored-cache.json のみ）。
 */
import { DatabaseSync } from "node:sqlite";
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

// ================================================================ 0. 設定
const P2_START = "20260615";
const P3_START = "20260726";
const HIST_WARM_CUTOFF = "20260405"; // racer_race_historyはこの日以前に始まった開催だけ（DBのresults開始20260409と重複させない）
const NO_WARM = process.argv.includes("--no-warm");
const DB_PATH = path.join(process.cwd(), "scripts", "data", "local.sqlite");

const FORM_N = 20; // 直近N走
const RECENT_N = 5;
const WINDOW_DAYS = 120; // 位置別・決まり手・先頭頻度の窓
const K_FORM = 8; // 縮約の事前強度（擬似レース数）
const K_RECENT = 4;
const K_POS = 6;
const K_KIM = 6;

// ================================================================ 1. 時点情報だけの選手成績
type PosCat = "L" | "S" | "T" | "K"; // 先頭(ライン2車以上) / 番手 / 3番手以降 / 単騎
interface Rec {
  d: string; // YYYYMMDD
  f: number; // 着順
  fs: number; // 出走数
  pos: PosCat | null; // hist由来はnull
  k: string | null; // 決まり手（1・2着のみ）
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db
  .prepare(
    `select x.race_id rid, r.kaisai_date d, x.snum, x.finish_pos f, x.kimarite k, e.line_group lg, e.line_position lp
       from results x join races r on r.id = x.race_id
       left join entries e on e.race_id = x.race_id and e.car_num = x.car_num`
  )
  .all() as { rid: number; d: string; snum: string; f: number | null; k: string | null; lg: number | null; lp: string | null }[];
const raceSize = new Map<number, number>();
const lineSizeKey = new Map<string, number>();
for (const r of rows) {
  raceSize.set(r.rid, (raceSize.get(r.rid) ?? 0) + 1);
  if (r.lg != null) lineSizeKey.set(`${r.rid}:${r.lg}`, (lineSizeKey.get(`${r.rid}:${r.lg}`) ?? 0) + 1);
}
function posCat(lp: string | null, ls: number): PosCat | null {
  if (lp == null) return null;
  if (ls <= 1) return "K";
  if (lp === "先頭") return "L";
  if (lp === "番手") return "S";
  return "T";
}
const recs = new Map<string, Rec[]>();
const push = (snum: string, r: Rec) => {
  let a = recs.get(snum);
  if (!a) recs.set(snum, (a = []));
  a.push(r);
};
for (const r of rows) {
  if (r.f == null) continue;
  const ls = r.lg != null ? lineSizeKey.get(`${r.rid}:${r.lg}`) ?? 1 : 1;
  push(r.snum, { d: r.d, f: r.f, fs: raceSize.get(r.rid) ?? 7, pos: posCat(r.lp, ls), k: r.k });
}
let warmRecs = 0;
if (!NO_WARM) {
  const hist = db
    .prepare(
      `select snum, race_date_full d, finish_positions fp, scraped_at sa from racer_race_history
        where race_date_full is not null and race_date_full <= ?`
    )
    .all(HIST_WARM_CUTOFF) as { snum: string; d: string; fp: string; sa: string }[];
  for (const h of hist) {
    if (h.d > h.sa.slice(0, 10).replace(/-/g, "")) continue; // 年解決バグ（取得日より未来）を除外
    const base = new Date(`${h.d.slice(0, 4)}-${h.d.slice(4, 6)}-${h.d.slice(6, 8)}T00:00:00Z`);
    (h.fp ?? "").split(",").forEach((tok, i) => {
      const t = tok.trim();
      if (!t || t.startsWith("欠")) return;
      const m = /^(\d+)/.exec(t);
      const f = m ? Number(m[1]) : 9; // 落・失などは着外扱い
      const dd = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
      push(h.snum, { d: dd, f, fs: 7, pos: null, k: null });
      warmRecs++;
    });
  }
}
for (const a of recs.values()) a.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));

// 母集団の事前値（P2開始前のDB結果のみで計算＝walk-forward上も安全。本番移植ではこの定数を使う）
const prior = (() => {
  let n = 0, w = 0, t2 = 0, t3 = 0, af = 0;
  const pos: Record<PosCat, [number, number, number]> = { L: [0, 0, 0], S: [0, 0, 0], T: [0, 0, 0], K: [0, 0, 0] };
  const kim: Record<string, number> = { 逃: 0, 捲: 0, 差: 0, マ: 0 };
  let lead = 0, nPos = 0;
  for (const a of recs.values())
    for (const r of a) {
      if (r.d >= P2_START || r.pos == null) continue;
      n++;
      if (r.f === 1) w++;
      if (r.f <= 2) t2++;
      if (r.f <= 3) t3++;
      af += Math.min(1, (r.f - 1) / Math.max(1, r.fs - 1));
      pos[r.pos][0]++;
      if (r.f <= 2) pos[r.pos][1]++;
      if (r.f <= 3) pos[r.pos][2]++;
      if (r.k && r.f <= 2 && r.k in kim) kim[r.k]++;
      nPos++;
      if (r.pos === "L") lead++;
    }
  return {
    win: w / n, top2: t2 / n, top3: t3 / n, finNorm: af / n,
    posTop2: Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, v[1] / v[0]])) as Record<PosCat, number>,
    posTop3: Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, v[2] / v[0]])) as Record<PosCat, number>,
    kim: Object.fromEntries(Object.entries(kim).map(([k, v]) => [k, v / n])) as Record<string, number>,
    leadFreq: lead / nPos,
  };
})();

const daysBefore = (d: string, days: number) => {
  const t = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getTime() - days * 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
};
const shr = (x: number, n: number, p: number, k: number) => (x + k * p) / (n + k);

interface Form {
  nPrior: number; // 窓内の前走数（<=FORM_N）
  win: number;
  top2: number;
  top3: number;
  finNorm: number; // (着-1)/(頭数-1) の平均（小さいほど良い）
  rec3: number; // 直近5走の3着内率
  posTop2: Record<PosCat, number>;
  posTop3: Record<PosCat, number>;
  nige: number; // 120日内、逃げで1・2着 / 出走
  makuri: number;
  sashi: number;
  mark: number;
  leadFreq: number; // 120日内、ライン先頭(2車以上)で走った割合
}
const formCache = new Map<string, Form>();
function form(snum: string, date: string): Form {
  const key = `${snum}:${date}`;
  const hit = formCache.get(key);
  if (hit) return hit;
  const a = recs.get(snum) ?? [];
  // 二分探索：date未満の最後
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m].d < date) lo = m + 1;
    else hi = m;
  }
  const end = lo; // a[0..end) が厳密に前
  let n = 0, w = 0, t2 = 0, t3 = 0, af = 0, r3 = 0, rn = 0;
  for (let i = end - 1; i >= 0 && n < FORM_N; i--) {
    const r = a[i];
    n++;
    if (r.f === 1) w++;
    if (r.f <= 2) t2++;
    if (r.f <= 3) t3++;
    af += Math.min(1, (r.f - 1) / Math.max(1, r.fs - 1));
    if (rn < RECENT_N) {
      rn++;
      if (r.f <= 3) r3++;
    }
  }
  const since = daysBefore(date, WINDOW_DAYS);
  const pc: Record<PosCat, [number, number, number]> = { L: [0, 0, 0], S: [0, 0, 0], T: [0, 0, 0], K: [0, 0, 0] };
  const kc: Record<string, number> = { 逃: 0, 捲: 0, 差: 0, マ: 0 };
  let np = 0, lead = 0;
  for (let i = end - 1; i >= 0 && a[i].d >= since; i--) {
    const r = a[i];
    if (r.pos == null) continue;
    np++;
    pc[r.pos][0]++;
    if (r.f <= 2) pc[r.pos][1]++;
    if (r.f <= 3) pc[r.pos][2]++;
    if (r.k && r.f <= 2 && r.k in kc) kc[r.k]++;
    if (r.pos === "L") lead++;
  }
  const out: Form = {
    nPrior: n,
    win: shr(w, n, prior.win, K_FORM),
    top2: shr(t2, n, prior.top2, K_FORM),
    top3: shr(t3, n, prior.top3, K_FORM),
    finNorm: shr(af, n, prior.finNorm, K_FORM),
    rec3: shr(r3, rn, prior.top3, K_RECENT),
    posTop2: Object.fromEntries((["L", "S", "T", "K"] as PosCat[]).map((p) => [p, shr(pc[p][1], pc[p][0], prior.posTop2[p], K_POS)])) as Record<PosCat, number>,
    posTop3: Object.fromEntries((["L", "S", "T", "K"] as PosCat[]).map((p) => [p, shr(pc[p][2], pc[p][0], prior.posTop3[p], K_POS)])) as Record<PosCat, number>,
    nige: shr(kc["逃"], np, prior.kim["逃"], K_KIM),
    makuri: shr(kc["捲"], np, prior.kim["捲"], K_KIM),
    sashi: shr(kc["差"], np, prior.kim["差"], K_KIM),
    mark: shr(kc["マ"], np, prior.kim["マ"], K_KIM),
    leadFreq: shr(lead, np, prior.leadFreq, K_KIM),
  };
  formCache.set(key, out);
  return out;
}

// ================================================================ 2. 特徴量（ライン構造 + 時点成績のみ）
const POS: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4, "5番手": 5, "6番手": 6 };
interface Ctx {
  h: CEntry;
  hf: Form;
  others: CEntry[];
  of: Map<number, Form>;
  lineSize: Map<number, number>;
  nLines: number;
  girls: boolean;
}
function buildCtx(r: CRace): Ctx {
  const h = r.entries[0];
  const others = r.entries.slice(1);
  const lineSize = new Map<number, number>();
  for (const e of r.entries) if (e.lineGroup != null) lineSize.set(e.lineGroup, (lineSize.get(e.lineGroup) ?? 0) + 1);
  const of = new Map<number, Form>();
  for (const e of others) of.set(e.car, form(e.snum, r.date));
  return { h, hf: form(h.snum, r.date), others, of, lineSize, nLines: lineSize.size, girls: r.girls };
}
const STRUCT = [
  "sameBehind1", // ◎と同ライン・◎の直後
  "sameFront", // ◎と同ライン・◎より前
  "sameFar", // ◎と同ライン・2つ以上後ろ
  "behind1_hNotLeader", // sameBehind1 × ◎が先頭でない
  "behind1_hNige", // sameBehind1 × ◎の時点逃げ率（逃げで1・2着/出走）
  "behind1_mark", // sameBehind1 × 本人の時点マーク率
  "rivalLeader", // 他ライン(2車以上)の先頭
  "rivalLeader_big", // 他ライン先頭 × そのラインが3車以上
  "rivalSecond", // 他ラインの番手
  "rivalThird", // 他ラインの3番手以降
  "tanki", // 単騎（ライン1車）
  "car1to3", // 車番1〜3
] as const;
const FORMF = [
  "fTop2", // 直近20走2連対率（縮約）
  "fTop3", // 直近20走3連対率（縮約）
  "fWin", // 直近20走勝率（縮約）
  "fFin", // 直近20走 正規化平均着順（縮約、小さいほど良い）
  "fRec3", // 直近5走3連対率（縮約）
  "fPosTop2", // 今回と同じ位置区分での120日2連対率（縮約）
  "fNige", // 120日 逃げ1・2着率
  "fMakuri", // 120日 捲り1・2着率
  "fSashi", // 120日 差し1・2着率
  "fMark", // 120日 マーク2着率
  "fLead", // 120日 先頭(2車以上ライン)で走った割合
  "fNewbie", // 直近20走窓の走数が5未満
] as const;
const BASE = [...STRUCT, ...FORMF] as const;
const THIRD_EXTRA = ["sameAs2nd", "behind2nd1", "front2nd", "sameAs2nd_and2ndSameH"] as const;
const ALL3 = [...BASE, ...THIRD_EXTRA] as const;

function catOf(e: CEntry, x: Ctx): PosCat {
  const ls = e.lineGroup != null ? x.lineSize.get(e.lineGroup) ?? 1 : 1;
  if (ls <= 1) return "K";
  if (e.linePos === "先頭") return "L";
  if (e.linePos === "番手") return "S";
  return "T";
}
function baseFeat(c: CEntry, x: Ctx): number[] {
  const g = x.girls;
  const same = !g && x.h.lineGroup != null && c.lineGroup === x.h.lineGroup;
  const ph = POS[x.h.linePos ?? ""] ?? 1;
  const pc = POS[c.linePos ?? ""] ?? 1;
  const behind1 = same && pc === ph + 1 ? 1 : 0;
  const ls = c.lineGroup != null ? x.lineSize.get(c.lineGroup) ?? 1 : 1;
  const rivalLeader = !g && !same && ls >= 2 && c.linePos === "先頭" ? 1 : 0;
  const f = x.of.get(c.car)!;
  return [
    behind1,
    same && pc < ph ? 1 : 0,
    same && pc >= ph + 2 ? 1 : 0,
    behind1 * (x.h.linePos === "先頭" ? 0 : 1),
    behind1 * x.hf.nige,
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
    f.posTop2[g ? "K" : catOf(c, x)],
    f.nige,
    f.makuri,
    f.sashi,
    f.mark,
    f.leadFreq,
    f.nPrior < 5 ? 1 : 0,
  ];
}
function thirdFeat(c: CEntry, s: CEntry, x: Ctx): number[] {
  const same2 = !x.girls && s.lineGroup != null && c.lineGroup === s.lineGroup;
  const ps = POS[s.linePos ?? ""] ?? 1;
  const pc = POS[c.linePos ?? ""] ?? 1;
  const sSameH = !x.girls && x.h.lineGroup != null && s.lineGroup === x.h.lineGroup;
  return [...baseFeat(c, x), same2 ? 1 : 0, same2 && pc === ps + 1 ? 1 : 0, same2 && pc < ps ? 1 : 0, same2 && sSameH ? 1 : 0];
}

// ================================================================ 3. 条件付きロジット（second-third-model.tsと同じNewton+L2）
interface Group { X: number[][]; y: number }
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
function fit(groups: Group[], dim: number, lambda = 2): number[] {
  let w = new Array(dim).fill(0);
  for (let it = 0; it < 40; it++) {
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

// ================================================================ 4. データセット
interface Sample { r: CRace; x: Ctx; cands: CEntry[]; second: number; third: number }
function samples(races: CRace[]): Sample[] {
  const out: Sample[] = [];
  for (const r of races) {
    if (r.deadHeat || r.entries.length < 3) continue;
    const [a, b, c] = r.actual.split("-").map(Number);
    if (a !== r.entries[0].car) continue;
    const x = buildCtx(r);
    const si = x.others.findIndex((e) => e.car === b);
    const ti = x.others.findIndex((e) => e.car === c);
    if (si < 0 || ti < 0) continue;
    out.push({ r, x, cands: x.others, second: si, third: ti });
  }
  return out;
}
type Mask = (f: string) => boolean;
const applyMask = (v: number[], names: readonly string[], keep: Mask) => v.map((x, i) => (keep(names[i]) ? x : 0));
interface Model { w2: number[]; w3: number[]; keep: Mask }
function fitModel(S: Sample[], keep: Mask = () => true): Model {
  const g2 = S.map((s) => ({ X: s.cands.map((c) => applyMask(baseFeat(c, s.x), BASE, keep)), y: s.second }));
  const g3 = S.map((s) => {
    const sec = s.cands[s.second];
    const rest = s.cands.filter((_, i) => i !== s.second);
    return { X: rest.map((c) => applyMask(thirdFeat(c, sec, s.x), ALL3, keep)), y: rest.indexOf(s.cands[s.third]) };
  });
  return { w2: fit(g2, BASE.length), w3: fit(g3, ALL3.length), keep };
}
type PairDist = { pair: [number, number]; p: number }[];
function secondDist(x: Ctx, m: Model) {
  return softmax(x.others.map((c) => applyMask(baseFeat(c, x), BASE, m.keep)), m.w2).map((p, i) => ({ car: x.others[i].car, p }));
}
function modelPairs(x: Ctx, m: Model): PairDist {
  const p2 = softmax(x.others.map((c) => applyMask(baseFeat(c, x), BASE, m.keep)), m.w2);
  const out: PairDist = [];
  x.others.forEach((sec, j) => {
    const rest = x.others.filter((_, i) => i !== j);
    const p3 = softmax(rest.map((c) => applyMask(thirdFeat(c, sec, x), ALL3, m.keep)), m.w3);
    rest.forEach((t, k) => out.push({ pair: [sec.car, t.car], p: p2[j] * p3[k] }));
  });
  return out.sort((a, b) => b.p - a.p);
}

// ---- 現行honmeiPool順（順位one-hotロジットで較正、同じtrainでfit）
const RANK_DIM = 8;
const poolOrder = (r: CRace, cars: number[]) => r.honmeiPool.filter((c) => cars.includes(c));
function rankX(order: number[], cars: number[]): number[][] {
  return cars.map((car) => {
    const v = new Array(RANK_DIM).fill(0);
    const k = order.indexOf(car);
    v[Math.min(k < 0 ? RANK_DIM - 1 : k, RANK_DIM - 1)] = 1;
    return v;
  });
}
interface PoolModel { a: number[]; b: number[] }
function fitPool(S: Sample[]): PoolModel {
  const g2: Group[] = [], g3: Group[] = [];
  for (const s of S) {
    const cars = s.cands.map((c) => c.car);
    const ord = poolOrder(s.r, cars);
    g2.push({ X: rankX(ord, cars), y: s.second });
    const sec = cars[s.second];
    const rest = cars.filter((c) => c !== sec);
    g3.push({ X: rankX(ord.filter((c) => c !== sec), rest), y: rest.indexOf(cars[s.third]) });
  }
  return { a: fit(g2, RANK_DIM, 0.5), b: fit(g3, RANK_DIM, 0.5) };
}
function poolSecond(s: Sample, pm: PoolModel) {
  const cars = s.cands.map((c) => c.car);
  return softmax(rankX(poolOrder(s.r, cars), cars), pm.a).map((p, i) => ({ car: cars[i], p }));
}
function poolPairs(s: Sample, pm: PoolModel): PairDist {
  const cars = s.cands.map((c) => c.car);
  const ord = poolOrder(s.r, cars);
  const p2 = softmax(rankX(ord, cars), pm.a);
  const out: PairDist = [];
  cars.forEach((sec, j) => {
    const rest = cars.filter((_, i) => i !== j);
    const p3 = softmax(rankX(ord.filter((c) => c !== sec), rest), pm.b);
    rest.forEach((t, k) => out.push({ pair: [sec, t], p: p2[j] * p3[k] }));
  });
  return out.sort((a, b) => b.p - a.p);
}

// ================================================================ 5. 指標
const KS = [1, 2, 3, 6];
interface Met { n: number; top1: number; top2: number; pairK: number[]; ll2: number; llPair: number }
function metrics(S: Sample[], sec: (s: Sample) => { car: number; p: number }[], pairs: (s: Sample) => PairDist): Met {
  const m: Met = { n: S.length, top1: 0, top2: 0, pairK: KS.map(() => 0), ll2: 0, llPair: 0 };
  for (const s of S) {
    const sc = s.cands[s.second].car, tc = s.cands[s.third].car;
    const p2 = sec(s).sort((a, b) => b.p - a.p);
    const r2 = p2.findIndex((e) => e.car === sc);
    if (r2 < 1) m.top1++;
    if (r2 < 2) m.top2++;
    m.ll2 -= Math.log(Math.max(1e-12, p2[r2].p));
    const pd = pairs(s);
    const rp = pd.findIndex((e) => e.pair[0] === sc && e.pair[1] === tc);
    KS.forEach((k, i) => (rp < k ? m.pairK[i]++ : 0));
    m.llPair -= Math.log(Math.max(1e-12, pd[rp].p));
  }
  const n = Math.max(1, S.length);
  return { ...m, top1: m.top1 / n, top2: m.top2 / n, pairK: m.pairK.map((v) => v / n), ll2: m.ll2 / n, llPair: m.llPair / n };
}
const pc1 = (v: number) => (v * 100).toFixed(1).padStart(5);
function pm(label: string, m: Met) {
  console.log(
    `   ${label.padEnd(22)} n=${String(m.n).padStart(4)} 2着top1 ${pc1(m.top1)} top2 ${pc1(m.top2)} | pair@1/2/3/6 ${m.pairK.map(pc1).join(" ")} | LL2 ${m.ll2.toFixed(3)} LLpair ${m.llPair.toFixed(3)}`
  );
}

// ================================================================ 6. 実行：walk-forward
const all = loadCache();
// cacheのraceIdとDBの整合チェック（entriesのsnum一致）
{
  const ent = db.prepare(`select race_id, car_num, snum from entries`).all() as { race_id: number; car_num: number; snum: string }[];
  const m = new Map(ent.map((e) => [`${e.race_id}:${e.car_num}`, e.snum]));
  let ok = 0, ng = 0;
  for (const r of all) for (const e of r.entries) (m.get(`${r.raceId}:${e.car}`) === e.snum ? ok++ : ng++);
  console.log(`cache↔DB snum一致 ${ok} / 不一致 ${ng}；warm-start hist走数 ${warmRecs}${NO_WARM ? "（--no-warm）" : ""}`);
  console.log(`prior: win ${prior.win.toFixed(3)} top2 ${prior.top2.toFixed(3)} top3 ${prior.top3.toFixed(3)} fin ${prior.finNorm.toFixed(3)} posTop2 ${JSON.stringify(prior.posTop2)} kim ${JSON.stringify(prior.kim)} lead ${prior.leadFreq.toFixed(3)}`);
}
type Period = "P1" | "P2" | "P3";
const period = (d: string): Period => (d < P2_START ? "P1" : d < P3_START ? "P2" : "P3");
const PLABEL: Record<Period, string> = {
  P1: `P1 <${P2_START}（train=P2+P3の逆向き）`,
  P2: `P2 ${P2_START}〜${P3_START}（train=P1）`,
  P3: `P3 >=${P3_START}（train=P1+P2）`,
};
const trainFilter: Record<Period, (d: string) => boolean> = {
  P1: (d) => d >= P2_START,
  P2: (d) => d < P2_START,
  P3: (d) => d < P3_START,
};

const segS = { men: samples(all.filter((r) => !r.girls)), girls: samples(all.filter((r) => r.girls)) };
{
  const S = segS.men;
  const np = S.flatMap((s) => s.cands.map((c) => s.x.of.get(c.car)!.nPrior));
  for (const p of ["P1", "P2", "P3"] as Period[]) {
    const v = S.filter((s) => period(s.r.date) === p).flatMap((s) => s.cands.map((c) => s.x.of.get(c.car)!.nPrior));
    console.log(`  ${p} 候補の前走数(<=20) 平均 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} / 5走未満 ${pc1(v.filter((x) => x < 5).length / v.length)}%`);
  }
  void np;
}

const VARIANTS: [string, Mask][] = [
  ["struct+PIT form", () => true],
  ["structure only", (f) => (STRUCT as readonly string[]).includes(f) || (THIRD_EXTRA as readonly string[]).includes(f)],
  ["PIT form only(+car)", (f) => (FORMF as readonly string[]).includes(f) || f === "car1to3"],
];
const models: Record<string, Record<Period, Model>> = {};
const pools: Record<string, Record<Period, PoolModel>> = {};
for (const seg of ["men", "girls"] as const) {
  models[seg] = {} as Record<Period, Model>;
  pools[seg] = {} as Record<Period, PoolModel>;
  console.log(`\n===== ${seg}：◎1着サンプル P1 ${segS[seg].filter((s) => period(s.r.date) === "P1").length} / P2 ${segS[seg].filter((s) => period(s.r.date) === "P2").length} / P3 ${segS[seg].filter((s) => period(s.r.date) === "P3").length}`);
  for (const p of ["P2", "P3", "P1"] as Period[]) {
    const tr = segS[seg].filter((s) => trainFilter[p](s.r.date));
    const te = segS[seg].filter((s) => period(s.r.date) === p);
    const pmod = fitPool(tr);
    pools[seg][p] = pmod;
    console.log(`  [${PLABEL[p]}] train ${tr.length}`);
    for (const [vn, keep] of VARIANTS) {
      if (seg === "girls" && vn === "structure only") continue;
      const m = fitModel(tr, keep);
      if (vn === "struct+PIT form") models[seg][p] = m;
      pm(vn, metrics(te, (s) => secondDist(s.x, m), (s) => modelPairs(s.x, m)));
    }
    pm("現行honmeiPool順", metrics(te, (s) => poolSecond(s, pmod), (s) => poolPairs(s, pmod)));
  }
}

// ================================================================ 7. 戦略チェック（全候補レース母数、100円/点）
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
interface Agg { n: number; nAll: number; hitsAll: number; points: number; hits: number; stake: number; ret: number; hitPays: number[]; per: { s: number; p: number }[] }
function agg(races: CRace[], fn: Fn): Agg {
  const a: Agg = { n: 0, nAll: 0, hitsAll: 0, points: 0, hits: 0, stake: 0, ret: 0, hitPays: [], per: [] };
  for (const r of races) {
    const c = fn(r);
    if (c.length === 0) continue;
    a.nAll++;
    if (c.includes(r.actual)) a.hitsAll++;
    if (!r.hasOdds) continue;
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
  if (a.per.length === 0) return [0, 0];
  const rnd = mulberry32(12345);
  const vals: number[] = [];
  const n = a.per.length;
  for (let i = 0; i < iters; i++) {
    let s = 0, p = 0;
    for (let j = 0; j < n; j++) {
      const x = a.per[(rnd() * n) | 0];
      s += x.s;
      p += x.p;
    }
    vals.push(p / s);
  }
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(iters * 0.05)], vals[Math.floor(iters * 0.95)]];
}
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const daysIn: Record<Period, number> = { P1: 0, P2: 0, P3: 0 };
for (const d of new Set(all.map((r) => r.date))) daysIn[period(d)]++;
function stratLine(label: string, races: CRace[], fn: Fn, p: Period) {
  const a = agg(races, fn);
  const ci = bootCI(a);
  console.log(
    `   ${label.padEnd(30)} n=${String(a.nAll).padStart(4)} ${(a.nAll / daysIn[p]).toFixed(2)}件/日 点${(a.points / Math.max(1, a.n)).toFixed(1)}` +
      ` 的中${String(a.hitsAll).padStart(3)} (${pct(a.hitsAll / Math.max(1, a.nAll))})` +
      ` | odds有${a.n} 回収${pct(roi(a)).padStart(5)} ex1 ${pct(exTop(a, 1)).padStart(4)} ex3 ${pct(exTop(a, 3)).padStart(4)} CI[${pct(ci[0])},${pct(ci[1])}]`
  );
}
const ctxCache = new Map<number, Ctx>();
const ctxOf = (r: CRace) => {
  let x = ctxCache.get(r.raceId);
  if (!x) ctxCache.set(r.raceId, (x = buildCtx(r)));
  return x;
};
function modelTop(r: CRace, k: number, excludeOwnLine = false): string[] {
  const m = models[r.girls ? "girls" : "men"][period(r.date)];
  const x = ctxOf(r);
  const hg = r.entries[0].lineGroup;
  const lgOf = new Map(r.entries.map((e) => [e.car, e.lineGroup]));
  let pd = modelPairs(x, m);
  if (excludeOwnLine && !r.girls && hg != null) pd = pd.filter((e) => !(lgOf.get(e.pair[0]) === hg && lgOf.get(e.pair[1]) === hg));
  return pd.slice(0, k).map((e) => `${r.entries[0].car}-${e.pair[0]}-${e.pair[1]}`);
}

const sameTop3 = (r: CRace) => {
  if (r.entries.length < 3 || r.entries.length === 9) return false;
  const [a, b, c] = r.entries;
  return a.lineGroup != null && a.lineGroup === b.lineGroup && b.lineGroup === c.lineGroup;
};
const valid = all.filter((r) => !r.deadHeat);
const bariCur = valid.filter(isBarikataCandidate);
const bariSente = valid.filter((r) => sameTop3(r) && r.margin >= 7 && r.entries[0].linePos === "先頭");
const gensen1013 = selectGensen(all).filter((r) => r.margin >= 10 && r.margin < 13 && !r.deadHeat);
for (const p of ["P1", "P2", "P3"] as Period[]) {
  const inP = (rs: CRace[]) => rs.filter((r) => period(r.date) === p);
  console.log(`\n==== 戦略 ${PLABEL[p]}（開催日${daysIn[p]}）`);
  console.log("  [バリカタ 1点]");
  stratLine("現行条件×現行並び", inP(bariCur), (r) => [currentBarikataCombo(r)], p);
  stratLine("現行条件×モデルtop1ペア", inP(bariCur), (r) => modelTop(r, 1), p);
  stratLine("◎先頭&m>=7×現行並び", inP(bariSente), (r) => [currentBarikataCombo(r)], p);
  stratLine("◎先頭&m>=7×モデルtop1ペア", inP(bariSente), (r) => modelTop(r, 1), p);
  console.log("  [厳選 margin10-13]");
  stratLine("現行 本命シナリオ", inP(gensen1013), honmeiCombos, p);
  for (const k of [1, 2, 3, 4, 6]) stratLine(`モデル top${k}`, inP(gensen1013), (r) => modelTop(r, k), p);
  for (const k of [1, 2, 3, 4, 6]) stratLine(`モデル top${k}（◎ライン独占ペア除外）`, inP(gensen1013), (r) => modelTop(r, k, true), p);
}
// 3期間合算（各期間はそれぞれのwalk-forwardモデル）
{
  console.log(`\n==== 戦略 P2+P3合算（walk-forwardのみ、P1除外）`);
  const wf = (rs: CRace[]) => rs.filter((r) => r.date >= P2_START);
  const pAll = "P2" as Period;
  daysIn.P2 += daysIn.P3; // 件/日の分母をP2+P3に
  stratLine("バリカタ 現行", wf(bariCur), (r) => [currentBarikataCombo(r)], pAll);
  stratLine("バリカタ 現行条件×モデル", wf(bariCur), (r) => modelTop(r, 1), pAll);
  stratLine("バリカタ ◎先頭m7×現行並び", wf(bariSente), (r) => [currentBarikataCombo(r)], pAll);
  stratLine("バリカタ ◎先頭m7×モデル", wf(bariSente), (r) => modelTop(r, 1), pAll);
  stratLine("厳選10-13 現行", wf(gensen1013), honmeiCombos, pAll);
  for (const k of [1, 2, 3, 4, 6]) stratLine(`厳選10-13 モデルtop${k}`, wf(gensen1013), (r) => modelTop(r, k), pAll);
  for (const k of [1, 2, 3, 4, 6]) stratLine(`厳選10-13 モデルtop${k} 独占除外`, wf(gensen1013), (r) => modelTop(r, k, true), pAll);
  daysIn.P2 -= daysIn.P3;
}

// ================================================================ 8. 本番用：全期間でfitして保存
const finalModels: Record<string, unknown> = {};
for (const seg of ["men", "girls"] as const) {
  const m = fitModel(segS[seg]);
  console.log(`\n[最終モデル ${seg}（全${segS[seg].length}件でfit）]`);
  console.log("  2着: " + BASE.map((f, i) => `${f}=${m.w2[i].toFixed(2)}`).join(" "));
  console.log("  3着: " + ALL3.map((f, i) => `${f}=${m.w3[i].toFixed(2)}`).join(" "));
  finalModels[seg] = {
    trainSamples: segS[seg].length,
    second: Object.fromEntries(BASE.map((f, i) => [f, +m.w2[i].toFixed(5)])),
    third: Object.fromEntries(ALL3.map((f, i) => [f, +m.w3[i].toFixed(5)])),
    note: seg === "girls" ? "ガールズは構造特徴量を全て0として計算（ライン無し扱い）。fPosTop2は区分Kを使う。" : undefined,
  };
}
const out = {
  description:
    "P(2着=j|◎1着) ∝ exp(Σ second[f]·x_f(j))、P(3着=k|◎1着,2着=j) ∝ exp(Σ third[f]·x_f(k;j))。候補=◎以外の全員（◎=totalScore1位）。" +
    "racersテーブルのスナップショット成績・totalScore・honmeiPool順位は一切使わない。成績系は全て「そのレースの開催日より前」のresults＋entriesのみ。" +
    "ペア確率 = P2(j)·P3(k|j)。softmaxなので定数項は不要。",
  source: "scripts/research/second-third-model-pit.ts",
  priors: {
    note: `P2開始(${P2_START})前のresults×entries（位置不明行は除外）から計算した母集団値。縮約は (x + K·prior)/(n + K)。`,
    win: +prior.win.toFixed(5),
    top2: +prior.top2.toFixed(5),
    top3: +prior.top3.toFixed(5),
    finNorm: +prior.finNorm.toFixed(5),
    posTop2: Object.fromEntries(Object.entries(prior.posTop2).map(([k, v]) => [k, +v.toFixed(5)])),
    kim: Object.fromEntries(Object.entries(prior.kim).map(([k, v]) => [k, +v.toFixed(5)])),
    leadFreq: +prior.leadFreq.toFixed(5),
  },
  shrinkageK: { form20: K_FORM, recent5: K_RECENT, position: K_POS, kimariteAndLead: K_KIM },
  history: {
    rule: "選手snumのresults（finish_pos非NULL）を races.kaisai_date < 今回の開催日 で絞り、日付降順。同日の別レースは使わない（1日1走前提）。",
    form20: `直近${FORM_N}走（日数制限なし）`,
    recent5: `直近${RECENT_N}走`,
    window120: `開催日の${WINDOW_DAYS}日前以降〜前日（kaisai_date >= 今回-${WINDOW_DAYS}日 かつ < 今回）。entries.line_positionが取れる走のみ`,
    posCat: "L=line_position先頭かつそのレースの同line_group人数>=2 / S=番手(人数>=2) / T=3番手以降(人数>=2) / K=同line_group人数<=1（単騎、line_group NULL含む）",
    finNorm: "(finish_pos-1)/(そのレースのresults行数-1)、上限1",
    researchWarmStart: `研究時のみ：DB結果が始まる前の期間を埋めるため racer_race_history（race_date_full<=${HIST_WARM_CUTOFF}、取得日より未来の行を除外）の着順を開催初日から1日ずつずらして form20/recent5 にだけ加えた（位置・決まり手は無し）。本番はresultsが半年分あるので不要。`,
  },
  features: {
    sameBehind1: "◎と同line_group（男子のみ）かつ 本人の隊列位置 = ◎の位置+1（先頭=1,番手=2,3番手=3…）",
    sameFront: "◎と同line_group かつ 本人の位置 < ◎の位置",
    sameFar: "◎と同line_group かつ 本人の位置 >= ◎の位置+2",
    behind1_hNotLeader: "sameBehind1 × (◎のline_positionが先頭でない)",
    behind1_hNige: "sameBehind1 × ◎のfNige",
    behind1_mark: "sameBehind1 × 本人のfMark",
    rivalLeader: "◎と別ライン・本人ライン人数>=2・line_position=先頭",
    rivalLeader_big: "rivalLeader × 本人ライン人数>=3",
    rivalSecond: "◎と別ライン・本人ライン人数>=2・番手",
    rivalThird: "◎と別ライン・本人ライン人数>=3・位置>=3",
    tanki: "本人のline_group人数==1（男子のみ）",
    car1to3: "車番<=3",
    fTop2: `直近${FORM_N}走の2着以内数 → 縮約(K=${K_FORM}, prior.top2)`,
    fTop3: `直近${FORM_N}走の3着以内数 → 縮約(K=${K_FORM}, prior.top3)`,
    fWin: `直近${FORM_N}走の1着数 → 縮約(K=${K_FORM}, prior.win)`,
    fFin: `直近${FORM_N}走のfinNorm合計 → 縮約(K=${K_FORM}, prior.finNorm)`,
    fRec3: `直近${RECENT_N}走の3着以内数 → 縮約(K=${K_RECENT}, prior.top3)`,
    fPosTop2: `120日窓で「今回の本人の位置区分(L/S/T/K)」と同じ区分で走った走の2着以内数 → 縮約(K=${K_POS}, prior.posTop2[区分])。ガールズは区分Kで固定`,
    fNige: `120日窓で (finish_pos<=2 かつ results.kimarite='逃') の数 / 窓内走数 → 縮約(K=${K_KIM}, prior.kim.逃)`,
    fMakuri: "同上 kimarite='捲'",
    fSashi: "同上 kimarite='差'",
    fMark: "同上 kimarite='マ'",
    fLead: `120日窓で位置区分Lの走数 / 窓内走数 → 縮約(K=${K_KIM}, prior.leadFreq)`,
    fNewbie: `直近${FORM_N}走窓の走数 < 5`,
    sameAs2nd: "（3着段のみ）2着と同line_group（男子）",
    behind2nd1: "（3着段のみ）2着と同ラインで位置 = 2着の位置+1",
    front2nd: "（3着段のみ）2着と同ラインで位置 < 2着の位置",
    sameAs2nd_and2ndSameH: "（3着段のみ）sameAs2nd かつ 2着が◎と同ライン",
  },
  models: finalModels,
  walkForwardModels: Object.fromEntries(
    (["men", "girls"] as const).map((seg) => [
      seg,
      Object.fromEntries(
        (["P2", "P3"] as Period[]).map((p) => [
          p,
          { train: p === "P2" ? `< ${P2_START}` : `< ${P3_START}`, second: models[seg][p].w2.map((v) => +v.toFixed(4)), third: models[seg][p].w3.map((v) => +v.toFixed(4)) },
        ])
      ),
    ])
  ),
  featureOrder: { second: BASE, third: ALL3 },
};
if (!NO_WARM) {
  writeFileSync(path.join(process.cwd(), "scripts", "data", "second-third-model-pit.json"), JSON.stringify(out, null, 2));
  console.log("\nsaved scripts/data/second-third-model-pit.json");
}
