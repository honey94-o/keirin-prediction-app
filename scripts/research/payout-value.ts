/**
 * 【検証結果: 不採用（買い目ルールは採用候補なし。m16+見送りのみ採用候補）】2026-10-15
 *
 * ■最重要：scored-cacheはリークを含む。entries.tokuten/syouritu/ren2/ren3/classRank等は
 *   racersテーブル（2026-10時点のスナップショット、updated_at 8〜10月）由来で時点データではない。
 *   競走得点は直近約4か月平均なので2026-06-15以降のレースは結果そのものが得点に入っている。
 *   証拠：男子全レースで◎1着率 37%(<0615) → 41%(0615-0725) → 44%(>=0726)、
 *   ◎-全-全の回収率 84% → 99% → 95%、◎-S1S2-S1S2 93% → 130% → 155%。
 *   → 従来のtrain(<0726)/test(>=0726)分割は「testほどリークが大きい」ので検証にならない。
 *   本スクリプトでは 窓外(<0615) / 窓内(>=0615) を併記し、さらに7.でracer_race_history
 *   （開催日付き着順）から作った時点データ「直近120日平均着順」で同じルールを再現テストした。
 *
 * ■結果（100円/点、ex1=最大払戻1件除外）
 *  - 得点順ルール ◎-T1-T23(2点)/◎-T12-T1234(6点) はスナップショット得点だと全母集団で>100%
 *    （例: 男子m10-16 ◎-T1-T23 177%/ex1 156%、boot90%[121,245]、窓外ex1 184% h32/窓内ex1 120% h55;
 *     厳選 ◎-T12-T1234 131%/ex1 116%、窓外ex1 87% h39/窓内ex1 119% h64）。
 *    しかし時点データ（直近120日平均着順）に置き換えると消える：男子m10-16 ◎-P1-P23 ex1 92%、
 *    厳選 ◎-P12-P1234 ex1 103%(窓外67%)、男子m>=8 ◎-P12-P1234 ex1 81%。→後知恵（その後伸びた選手を
 *    上位に置ける）による見かけの優位と判断。唯一 男子全レースの◎-P12-P123 が窓外ex1 104%/窓内104%
 *    (h498/h702) だが◎自体がリーク込みスコアで選ばれているので採用不可。
 *  - 厳選の◎-L1-L2（ライン決着1点）142%/ex1 125%/ex3 101%、boot[100,194]、窓外ex1 104% h17/窓内115% h30
 *    だが、より広い母集団では男子m>=10 97%/ex1 92%、m>=8 101%/ex1 97%で再現せず→選定の偶然とみなす。
 *  - 現行（本命シナリオ）厳選 121%/ex1 78%/ex3 67% boot[62,202]。
 *  - パターン統計（男子m>=10、◎1着時）：◎ライン123（同-同）は出現26%だが払戻中央340円・平均737円で、
 *    同-他 中央1120/平均3743、他-他 2650/5112、他-同 4660/9148。払戻の総量（平均×頻度）は
 *    同-同191に対し同-他671・他-他699・他-同723。現行の買い目は安い同-同/同-他に偏っている。
 *  - レース区分：margin16+は全ルールで赤字（厳選 現行73%/ex1 61% n=55・◎1着93%; 男子m16+ 全ルール
 *    ex1<70%; ガールズm>=16 現行73%）。リークは回収率を押し上げる向きなので「負け」の方は信頼度が高い。
 *    厳選では4分戦(現行61%)、◎ライン2車(61%)/4車(54%)、準決勝(58%)・選抜特選(56%)、◎得点が非◎最高未満
 *    (39%)も悪いがn=25〜64で薄い。
 *  - 試行数：個別ルール約37種、ルール×母集団の評価 約450（2.:112、4.:70、6.:227、7.:42）。
 *    単一分割でだけ良いものはノイズ扱い。
 *
 * ■推奨：買い目の作り替えは時点データのcacheを作り直すまで保留（build-scored-cacheでracersを
 *   日付時点の値に差し替えるのが先決）。margin>=16の厳選は見送り（or 1点以下に縮小）を候補に。
 *
 * 3連単の「どの組み合わせパターンに価値（回収率>100%）があるか」をscored-cache.json上で調べる。
 * 払戻は的中組のみ観測されるので、パターンPの払戻は「Pが起きたレースの払戻」から推定し、
 * ルールは全レースで実際に購入をシミュレートして回収率を出す（100円/点）。
 * train < 20260726 <= test。上位1件/3件除外・bootstrap 90%区間も出す。
 *
 * 実行: npx tsx scripts/research/payout-value.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadCache, selectGensen, honmeiCombos, type CRace, type CEntry } from "../lib/research-cache";
import { raceStage } from "../../lib/scoring";

const CUT = "20260726";
const all = loadCache().filter((r) => r.hasOdds && r.payout != null && !r.deadHeat);

// ---------- rider roles ----------
const POS: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4, "5番手": 5, "6番手": 6 };
interface Ctx {
  r: CRace;
  h: CEntry;
  others: CEntry[]; // 非◎ totalScore順
  lineSize: Map<number | null, number>;
  mates: CEntry[]; // ◎と同ラインの他者（隊列順）
  oth: CEntry[]; // 他ライン（2車以上のライン）
  solo: CEntry[]; // 単騎（ライン1車）
  tok: CEntry[]; // 非◎ 得点順
  othTok: CEntry[]; // 他ライン+単騎 得点順
  ninki: Map<number, number>;
}
const ctxCache = new WeakMap<CRace, Ctx>();
function ctx(r: CRace): Ctx {
  let c = ctxCache.get(r);
  if (c) return c;
  const h = r.entries[0];
  const others = r.entries.slice(1);
  const lineSize = new Map<number | null, number>();
  for (const e of r.entries) lineSize.set(e.lineGroup, (lineSize.get(e.lineGroup) ?? 0) + 1);
  const isSolo = (e: CEntry) => e.lineGroup == null || lineSize.get(e.lineGroup) === 1;
  const mates = others
    .filter((e) => !isSolo(e) && !isSolo(h) && e.lineGroup === h.lineGroup)
    .sort((a, b) => (POS[a.linePos ?? ""] ?? 9) - (POS[b.linePos ?? ""] ?? 9));
  const oth = others.filter((e) => !isSolo(e) && e.lineGroup !== h.lineGroup);
  const solo = others.filter(isSolo);
  const tk = (a: CEntry, b: CEntry) => (b.tokuten ?? 0) - (a.tokuten ?? 0);
  const tok = [...others].sort(tk);
  const othTok = [...oth, ...solo].sort(tk);
  c = { r, h, others, lineSize, mates, oth, solo, tok, othTok, ninki: new Map() };
  ctxCache.set(r, c);
  return c;
}
const fin = (r: CRace) => r.actual.split("-").map(Number);
const byCar = (r: CRace, car: number) => r.entries.find((e) => e.car === car)!;
const homeWin = (r: CRace) => fin(r)[0] === r.entries[0].car;

function role(c: Ctx, e: CEntry): string {
  if (c.mates.includes(e)) return `同${e.linePos}`;
  if (c.solo.includes(e)) return "単騎";
  return `他${e.linePos}`;
}

// ---------- populations ----------
const isGirls = (r: CRace) => r.girls;
const men = all.filter((r) => !isGirls(r));
const girls = all.filter(isGirls);
const notNine = (r: CRace) => r.entries.length !== 9;
const gensen = selectGensen(loadCache()).filter((r) => r.hasOdds && r.payout != null && !r.deadHeat);
const pops: Record<string, CRace[]> = {
  厳選: gensen,
  "男子m>=8": men.filter((r) => r.margin >= 8),
  "男子m>=10": men.filter((r) => r.margin >= 10),
  "ガールズm>=8": girls.filter((r) => r.margin >= 8),
};

// ---------- stats ----------
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
interface Res {
  n: number;
  pts: number;
  hits: number;
  roi: number;
  ex1: number;
  ex3: number;
  lo: number;
  hi: number;
}
function sim(races: CRace[], f: (r: CRace) => string[], boot = true): Res {
  const st: number[] = [];
  const py: number[] = [];
  for (const r of races) {
    const cs = f(r);
    if (!cs.length) continue;
    st.push(cs.length * 100);
    py.push(cs.includes(r.actual) ? r.payout! : 0);
  }
  const S = st.reduce((a, b) => a + b, 0);
  const P = py.reduce((a, b) => a + b, 0);
  const top = [...py].sort((a, b) => b - a);
  const ex = (k: number) => (S ? (P - top.slice(0, k).reduce((a, b) => a + b, 0)) / S : 0);
  let lo = NaN;
  let hi = NaN;
  if (boot && st.length) {
    const rs: number[] = [];
    let seed = 12345;
    const rnd = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let b = 0; b < 2000; b++) {
      let s = 0;
      let p = 0;
      for (let i = 0; i < st.length; i++) {
        const j = Math.floor(rnd() * st.length);
        s += st[j];
        p += py[j];
      }
      rs.push(p / s);
    }
    lo = q(rs, 0.05);
    hi = q(rs, 0.95);
  }
  return { n: st.length, pts: st.length ? S / 100 / st.length : 0, hits: py.filter((x) => x > 0).length, roi: S ? P / S : 0, ex1: ex(1), ex3: ex(3), lo, hi };
}
const pc = (x: number) => (isNaN(x) ? "  -  " : `${(x * 100).toFixed(0).padStart(4)}%`);
function line(label: string, races: CRace[], f: (r: CRace) => string[]) {
  const a = sim(races, f);
  const tr = sim(races.filter((r) => r.date < CUT), f, false);
  const te = sim(races.filter((r) => r.date >= CUT), f, false);
  const trEx = tr.ex1, teEx = te.ex1;
  const pass = trEx > 1 && teEx > 1 && tr.hits >= 15 && te.hits >= 15;
  console.log(
    `  ${label.padEnd(34)} n=${String(a.n).padStart(5)} 点${a.pts.toFixed(1).padStart(5)} 的${String(a.hits).padStart(4)}` +
      ` ROI${pc(a.roi)} ex1${pc(a.ex1)} ex3${pc(a.ex3)} [${pc(a.lo)},${pc(a.hi)}]` +
      ` | tr${pc(tr.roi)}/ex1${pc(trEx)} h${tr.hits} | te${pc(te.roi)}/ex1${pc(teEx)} h${te.hits}${pass ? "  ★PASS" : ""}`,
  );
  return { a, tr, te, pass };
}

// ---------- 1. pattern stats given ◎ 1着 ----------
type PStat = { n: number; freq: number; mean: number; median: number; p90: number; ninkiMed: number | null; ninkiN: number };
function patternTable(races: CRace[], key: (r: CRace) => string | null, title: string, minN = 20) {
  const wins = races.filter(homeWin);
  const g = new Map<string, CRace[]>();
  for (const r of wins) {
    const k = key(r);
    if (k == null) continue;
    (g.get(k) ?? g.set(k, []).get(k)!).push(r);
  }
  console.log(`\n### ${title}  (◎1着 ${wins.length}/${races.length})`);
  const out: Record<string, PStat> = {};
  const rows = [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [k, rs] of rows) {
    const p = rs.map((r) => r.payout!);
    const nk = rs.map((r) => r.payoutNinki).filter((x): x is number => x != null);
    const st: PStat = {
      n: rs.length,
      freq: rs.length / races.length,
      mean: p.reduce((a, b) => a + b, 0) / p.length,
      median: q(p, 0.5),
      p90: q(p, 0.9),
      ninkiMed: nk.length ? q(nk, 0.5) : null,
      ninkiN: nk.length,
    };
    out[k] = st;
    if (rs.length < minN) continue;
    console.log(
      `  ${k.padEnd(26)} n=${String(st.n).padStart(5)} 頻度${(st.freq * 100).toFixed(1).padStart(5)}% 平均${Math.round(st.mean).toString().padStart(6)} 中央${String(st.median).padStart(5)} p90${String(st.p90).padStart(6)}` +
        ` 人気中央${st.ninkiMed ?? "-"}(n${st.ninkiN})  ※平均×頻度=${(st.mean * st.freq).toFixed(0)}`,
    );
  }
  return out;
}

const r23 = (r: CRace) => {
  const [, b, c] = fin(r);
  return [byCar(r, b), byCar(r, c)];
};
const rel = (cx: Ctx, e: CEntry) => (cx.mates.includes(e) ? "同" : cx.solo.includes(e) ? "単" : "他");
const keys: Record<string, (r: CRace) => string | null> = {
  "役割(同/他/単×位置)": (r) => {
    const cx = ctx(r);
    const [b, c] = r23(r);
    return `${role(cx, b)}→${role(cx, c)}`;
  },
  "関係(同/他/単)": (r) => {
    const cx = ctx(r);
    const [b, c] = r23(r);
    return `${rel(cx, b)}-${rel(cx, c)}`;
  },
  "スコア順位(非◎)": (r) => {
    const cx = ctx(r);
    const [b, c] = r23(r);
    const k = (e: CEntry) => Math.min(cx.others.indexOf(e) + 1, 5);
    return `S${k(b)}-S${k(c)}`;
  },
  "得点順位(非◎)": (r) => {
    const cx = ctx(r);
    const [b, c] = r23(r);
    const k = (e: CEntry) => Math.min(cx.tok.indexOf(e) + 1, 5);
    return `T${k(b)}-T${k(c)}`;
  },
  ラインで決着: (r) => {
    const cx = ctx(r);
    const [b, c] = r23(r);
    return cx.mates.includes(b) && cx.mates.includes(c) ? "◎ライン123" : cx.mates.length >= 2 ? "◎ライン3車以上・非独占" : "◎ライン2車以下";
  },
};

const patternsOut: Record<string, Record<string, Record<string, PStat>>> = {};
for (const [pn, rs] of [
  ["男子(全)", men],
  ["男子m>=10", men.filter((r) => r.margin >= 10)],
  ["ガールズ(全)", girls],
] as const) {
  console.log(`\n================ 1. パターン統計: ${pn} ================`);
  patternsOut[pn] = {};
  for (const [kn, kf] of Object.entries(keys)) patternsOut[pn][kn] = patternTable(rs, kf, `${pn} / ${kn}`, pn.startsWith("ガ") ? 15 : 30);
}

// ---------- 2. rules ----------
const C = (a: CEntry | number, b: CEntry | number, c: CEntry | number) =>
  `${typeof a === "number" ? a : a.car}-${typeof b === "number" ? b : b.car}-${typeof c === "number" ? c : c.car}`;
function form(first: CEntry[], second: CEntry[], third: CEntry[]): string[] {
  const s = new Set<string>();
  for (const a of first) for (const b of second) for (const c of third) if (a !== b && b !== c && a !== c) s.add(C(a, b, c));
  return [...s];
}
const except = (xs: string[], ex: string[]) => xs.filter((x) => !ex.includes(x));
const L1 = (cx: Ctx) => cx.mates[0];
const L2 = (cx: Ctx) => cx.mates[1];
const lineFin = (cx: Ctx) => (cx.mates.length >= 2 ? [C(cx.h, cx.mates[0], cx.mates[1])] : []);

const rules: Record<string, (r: CRace) => string[]> = {
  "現行(本命シナリオ)": honmeiCombos,
  "◎-全-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.others, cx.others);
  },
  "◎-全-全 ただし◎L1L2除く": (r) => {
    const cx = ctx(r);
    return except(form([cx.h], cx.others, cx.others), lineFin(cx));
  },
  "◎-L1-L2のみ(ライン決着1点)": (r) => lineFin(ctx(r)),
  "◎-L1-全": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([cx.h], [L1(cx)], cx.others) : [];
  },
  "◎-L1-全 ただしL2除く": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([cx.h], [L1(cx)], cx.others.filter((e) => e !== L2(cx))) : [];
  },
  "◎-L1-他ライン得点上位2": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([cx.h], [L1(cx)], cx.othTok.slice(0, 2)) : [];
  },
  "◎-他得点1位-全": (r) => {
    const cx = ctx(r);
    return cx.othTok[0] ? form([cx.h], [cx.othTok[0]], cx.others) : [];
  },
  "◎-他得点上位2-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.othTok.slice(0, 2), cx.others);
  },
  "◎-他(非◎ライン)-他(非◎ライン)": (r) => {
    const cx = ctx(r);
    const o = [...cx.oth, ...cx.solo];
    return form([cx.h], o, o);
  },
  "◎-他得点上位2-他得点上位3": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.othTok.slice(0, 2), cx.othTok.slice(0, 3));
  },
  "◎-L1-他上位2 + ◎-他上位2-L1": (r) => {
    const cx = ctx(r);
    if (!L1(cx)) return [];
    return [...form([cx.h], [L1(cx)], cx.othTok.slice(0, 2)), ...form([cx.h], cx.othTok.slice(0, 2), [L1(cx)])];
  },
  "◎-T12-T1234(得点)": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.tok.slice(0, 2), cx.tok.slice(0, 4));
  },
  "◎-S12-S1234(スコア)": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.others.slice(0, 2), cx.others.slice(0, 4));
  },
  "◎-T12-T1234 ただし◎L1L2除く": (r) => {
    const cx = ctx(r);
    return except(form([cx.h], cx.tok.slice(0, 2), cx.tok.slice(0, 4)), lineFin(cx));
  },
  "◎-他先頭-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.oth.filter((e) => e.linePos === "先頭"), cx.others);
  },
  "◎-他番手-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.oth.filter((e) => e.linePos === "番手"), cx.others);
  },
  "◎-単騎-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.solo, cx.others);
  },
  "◎-全-L1": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([cx.h], cx.others, [L1(cx)]) : [];
  },
  "◎-他-L1 (L1は3着)": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([cx.h], [...cx.oth, ...cx.solo], [L1(cx)]) : [];
  },
  "L1-◎-全 (番手差し)": (r) => {
    const cx = ctx(r);
    return L1(cx) ? form([L1(cx)], [cx.h], cx.others) : [];
  },
  "全-◎-全 (◎2着)": (r) => {
    const cx = ctx(r);
    return form(cx.others, [cx.h], cx.others);
  },
  "他得点上位2-◎-全": (r) => {
    const cx = ctx(r);
    return form(cx.othTok.slice(0, 2), [cx.h], cx.others);
  },
  "全-全-◎ (◎3着)": (r) => {
    const cx = ctx(r);
    return form(cx.others, cx.others, [cx.h]);
  },
  "◎1着 他得点1位2着 L1 3着 1点": (r) => {
    const cx = ctx(r);
    return L1(cx) && cx.othTok[0] ? [C(cx.h, cx.othTok[0], L1(cx))] : [];
  },
  "◎-T1-T23 (2点)": (r) => {
    const cx = ctx(r);
    return form([cx.h], [cx.tok[0]], cx.tok.slice(1, 3));
  },
  "◎-T1T2-T1T2 (2点)": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.tok.slice(0, 2), cx.tok.slice(0, 2));
  },
  "◎-S1S2-S1S2 (2点)": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.others.slice(0, 2), cx.others.slice(0, 2));
  },
};

const ruleResults: Record<string, Record<string, unknown>> = {};
for (const [pn, rs] of Object.entries(pops)) {
  console.log(`\n================ 2. ルール: ${pn} (n=${rs.length}) ================`);
  for (const [rn, f] of Object.entries(rules)) {
    const res = line(rn, rs, f);
    (ruleResults[rn] ??= {})[pn] = res;
  }
}

// ---------- 3. race-level segments ----------
const nLines = (r: CRace) => new Set(r.entries.map((e) => e.lineGroup)).size;
const segs: Record<string, (r: CRace) => string> = {
  margin帯: (r) => (r.margin < 10 ? "8-10" : r.margin < 13 ? "10-13" : r.margin < 16 ? "13-16" : "16+"),
  頭数: (r) => `${r.entries.length}車`,
  グレード: (r) => r.grade ?? "?",
  段階: (r) => raceStage(r.syumoku) ?? "?",
  ライン数: (r) => `${Math.min(nLines(r), 5)}分戦`,
  "◎位置": (r) => r.entries[0].linePos ?? "?",
  "◎ライン車数": (r) => `${Math.min(ctx(r).mates.length + 1, 4)}車`,
  "◎脚質": (r) => r.entries[0].kyaku ?? "?",
  "◎得点差(対非◎最高)": (r) => {
    const cx = ctx(r);
    const g = (cx.h.tokuten ?? 0) - (cx.tok[0]?.tokuten ?? 0);
    return g < 0 ? "<0" : g < 3 ? "0-3" : g < 6 ? "3-6" : "6+";
  },
};
const segRules: Record<string, (r: CRace) => string[]> = {
  現行: honmeiCombos,
  "◎-全-全": rules["◎-全-全"],
  "◎-T12-T1234": rules["◎-T12-T1234(得点)"],
};
const winRate = (rs: CRace[]) => rs.filter(homeWin).length / Math.max(1, rs.length);
for (const [pn, rs] of [
  ["厳選", gensen],
  ["男子m>=8", pops["男子m>=8"]],
  ["ガールズm>=8", pops["ガールズm>=8"]],
] as const) {
  console.log(`\n================ 3. レース区分: ${pn} ================`);
  for (const [sn, sf] of Object.entries(segs)) {
    console.log(` -- ${sn}`);
    const g = new Map<string, CRace[]>();
    for (const r of rs) (g.get(sf(r)) ?? g.set(sf(r), []).get(sf(r))!).push(r);
    for (const [k, sub] of [...g.entries()].sort()) {
      if (sub.length < 15) continue;
      const parts = Object.entries(segRules).map(([n, f]) => {
        const a = sim(sub, f, false);
        const tr = sim(sub.filter((r) => r.date < CUT), f, false);
        const te = sim(sub.filter((r) => r.date >= CUT), f, false);
        return `${n}${pc(a.roi)}(ex1${pc(a.ex1)} tr${pc(tr.ex1)} te${pc(te.ex1)})`;
      });
      console.log(`   ${k.padEnd(8)} n=${String(sub.length).padStart(5)} ◎1着${(winRate(sub) * 100).toFixed(0)}%  ${parts.join("  ")}`);
    }
  }
}

writeFileSync(
  path.join(process.cwd(), "scripts", "data", "payout-patterns.json"),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      note: "【注意】tokuten等はracersスナップショット由来でリークあり（payout-value.ts冒頭参照）。払戻の構造（同ライン決着は安い等）は参考になるが、得点順位別の値は割り引くこと。◎=entries[0]が1着したレースに限った2・3着パターン別の払戻（100円あたり）。freq=母集団全レースに対する出現率（◎が負けたレース含む）。payoutNinkiは2026-09-10以降のみ。",
      population: { 男子: men.length, ガールズ: girls.length },
      patterns: patternsOut,
    },
    null,
    1,
  ),
);
console.log(`\nルール数 ${Object.keys(rules).length} × 母集団 ${Object.keys(pops).length}`);

// ---------- 4. 第2ラウンド：得点順ルールの頑健性（全マージン・帯別・分解） ----------
const tRules: Record<string, (r: CRace) => string[]> = {
  "◎-T1-T23": rules["◎-T1-T23 (2点)"],
  "◎-T1-T234": (r) => {
    const cx = ctx(r);
    return form([cx.h], [cx.tok[0]], cx.tok.slice(1, 4));
  },
  "◎-T12-T123": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.tok.slice(0, 2), cx.tok.slice(0, 3));
  },
  "◎-T12-T1234": rules["◎-T12-T1234(得点)"],
  "◎-T1-全": (r) => {
    const cx = ctx(r);
    return form([cx.h], [cx.tok[0]], cx.others);
  },
  "◎-全-T1": (r) => {
    const cx = ctx(r);
    return form([cx.h], cx.others, [cx.tok[0]]);
  },
};
const band = (lo: number, hi: number) => (r: CRace) => r.margin >= lo && r.margin < hi;
const pops2: Record<string, CRace[]> = {
  "男子 全": men,
  "男子 m<5": men.filter(band(-99, 5)),
  "男子 m5-8": men.filter(band(5, 8)),
  "男子 m8-10": men.filter(band(8, 10)),
  "男子 m10-16": men.filter(band(10, 16)),
  "男子 m16+": men.filter(band(16, 999)),
  "男子 m8-16 7車 非予選": men.filter((r) => band(8, 16)(r) && r.entries.length === 7 && raceStage(r.syumoku) !== "予選"),
  "ガールズ 全": girls,
  "厳選 (m16+除外)": gensen.filter((r) => r.margin < 16),
  "厳選 男子のみ": gensen.filter((r) => !r.girls),
};
for (const [pn, rs] of Object.entries(pops2)) {
  console.log(`\n================ 4. 得点順ルール: ${pn} (n=${rs.length}) ================`);
  for (const [rn, f] of Object.entries(tRules)) line(rn, rs, f);
  line("現行(本命シナリオ)", rs, honmeiCombos);
}

// T1が◎ライン番手かどうかで◎-T1-T23を分解
console.log("\n-- ◎-T1-T23 分解（男子m>=8）: T1の役割別");
{
  const rs = pops["男子m>=8"];
  const g = new Map<string, CRace[]>();
  for (const r of rs) {
    const cx = ctx(r);
    const k = role(cx, cx.tok[0]);
    (g.get(k) ?? g.set(k, []).get(k)!).push(r);
  }
  for (const [k, sub] of g) if (sub.length >= 30) line(`T1=${k}`, sub, tRules["◎-T1-T23"]);
}
console.log(`\n第2ラウンド ルール数 ${Object.keys(tRules).length + 1} × 母集団 ${Object.keys(pops2).length}`);

// ---------- 5. リーク検査：racers.heikin_tokuten等は2026-10時点のスナップショット（時点データではない） ----------
// 競走得点は直近約4か月の平均なので、6月中旬より前のレースはスナップショットの集計窓の外＝直接リークなし。
const periods: [string, (r: CRace) => boolean][] = [
  ["~0614(窓外)", (r) => r.date < "20260615"],
  ["0615~0725", (r) => r.date >= "20260615" && r.date < CUT],
  ["0726~(test)", (r) => r.date >= CUT],
];
const leakRules: Record<string, (r: CRace) => string[]> = {
  現行: honmeiCombos,
  "◎-全-全": rules["◎-全-全"],
  "◎-T1-T23": tRules["◎-T1-T23"],
  "◎-T12-T1234": tRules["◎-T12-T1234"],
  "◎-S1S2-S1S2": rules["◎-S1S2-S1S2 (2点)"],
  "◎-L1-L2": rules["◎-L1-L2のみ(ライン決着1点)"],
};
for (const [pn, rs] of [
  ["男子 全", men],
  ["男子 m10-16", men.filter(band(10, 16))],
  ["厳選", gensen],
  ["ガールズ 全", girls],
] as const) {
  console.log(`
================ 5. 期間別（リーク検査）: ${pn} ================`);
  for (const [per, pf] of periods) {
    const sub = rs.filter(pf);
    const parts = Object.entries(leakRules).map(([n, f]) => {
      const a = sim(sub, f, false);
      return `${n} ${pc(a.roi)}/ex1${pc(a.ex1)} h${a.hits}`;
    });
    console.log(`  ${per.padEnd(12)} n=${String(sub.length).padStart(5)} ◎1着${((winRate(sub)) * 100).toFixed(0)}% | ${parts.join(" | ")}`);
  }
}

// ---------- 6. 窓外(<0615)を「クリーン検証」とした再判定 ----------
// train/test(0726)はtestがスナップショット窓の内側＝リーク最大なので、
// 窓外(<0615) と 窓内(>=0615) の両方で ex1>100% かつ各15的中以上を「PASS2」とする。
const CLEAN = "20260615";
const allRules: Record<string, (r: CRace) => string[]> = { ...rules };
for (const [k, f] of Object.entries(tRules)) allRules[`[T]${k}`] ??= f;
const pops6: Record<string, CRace[]> = {
  厳選: gensen,
  "厳選 m<16": gensen.filter((r) => r.margin < 16),
  "男子 全": men,
  "男子 m>=8": pops["男子m>=8"],
  "男子 m10-16": men.filter(band(10, 16)),
  "男子 m8-16 7車 非予選": pops2["男子 m8-16 7車 非予選"],
  "ガールズ 全": girls,
};
let tried = 0;
const passList: string[] = [];
for (const [pn, rs] of Object.entries(pops6)) {
  console.log(`\n================ 6. 窓外/窓内判定: ${pn} (n=${rs.length}) ================`);
  for (const [rn, f] of Object.entries(allRules)) {
    const a = sim(rs, f);
    if (a.n === 0) continue;
    tried++;
    const e = sim(rs.filter((r) => r.date < CLEAN), f, false);
    const l = sim(rs.filter((r) => r.date >= CLEAN), f, false);
    const ok = e.ex1 > 1 && l.ex1 > 1 && e.hits >= 15 && l.hits >= 15;
    if (ok) passList.push(`${pn} / ${rn}`);
    console.log(
      `  ${rn.padEnd(34)} 点${a.pts.toFixed(1).padStart(5)} ROI${pc(a.roi)} ex1${pc(a.ex1)} ex3${pc(a.ex3)} [${pc(a.lo)},${pc(a.hi)}]` +
        ` | 窓外${pc(e.roi)}/ex1${pc(e.ex1)} h${e.hits} | 窓内${pc(l.roi)}/ex1${pc(l.ex1)} h${l.hits}${ok ? "  ★PASS2" : ""}`,
    );
  }
}
console.log(`\n6. 試行 ${tried} (ルール×母集団) / PASS2:\n  ${passList.join("\n  ")}`);

// ---------- 7. 時点データでの再現テスト ----------
// racers.heikin_tokuten は2026-10時点のスナップショット。4月のレースでも「その後伸びた選手」を
// 後知恵で上位に置けてしまう（窓外でも残るリーク）。racer_race_history（開催日付き着順）から
// 「レース前120日の平均着順」を時点データとして作り、得点順の代わりに使って同じルールを試す。
import { DatabaseSync } from "node:sqlite";
const hdb = new DatabaseSync(path.join(process.cwd(), "scripts", "data", "local.sqlite"), { readOnly: true });
const hist = new Map<string, { d: string; f: number[] }[]>();
for (const row of hdb.prepare("SELECT snum, race_date_full d, finish_positions f FROM racer_race_history WHERE race_date_full IS NOT NULL").all() as {
  snum: string;
  d: string;
  f: string | null;
}[]) {
  const fs = (row.f ?? "").split(",").map(Number).filter((x) => x >= 1 && x <= 9);
  if (!fs.length) continue;
  (hist.get(row.snum) ?? hist.set(row.snum, []).get(row.snum)!).push({ d: row.d, f: fs });
}
const ymd = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
function pitForm(snum: string, date: string): number {
  const t = ymd(date);
  const xs: number[] = [];
  for (const h of hist.get(snum) ?? []) {
    const dt = (t - ymd(h.d)) / 86400000;
    if (dt > 0 && dt <= 120) xs.push(...h.f);
  }
  return xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : 5; // 不明は中位扱い
}
const pitCache = new WeakMap<CRace, CEntry[]>();
const pit = (r: CRace) => {
  let p = pitCache.get(r);
  if (!p) {
    const sc = new Map(r.entries.slice(1).map((e) => [e, pitForm(e.snum, r.date)]));
    p = [...sc.keys()].sort((a, b) => sc.get(a)! - sc.get(b)!);
    pitCache.set(r, p);
  }
  return p;
};
const pitRules: Record<string, (r: CRace) => string[]> = {
  "◎-P1-P23": (r) => form([r.entries[0]], [pit(r)[0]], pit(r).slice(1, 3)),
  "◎-P12-P123": (r) => form([r.entries[0]], pit(r).slice(0, 2), pit(r).slice(0, 3)),
  "◎-P12-P1234": (r) => form([r.entries[0]], pit(r).slice(0, 2), pit(r).slice(0, 4)),
  "◎-T1-T23(参考)": tRules["◎-T1-T23"],
  "◎-T12-T1234(参考)": tRules["◎-T12-T1234"],
  "◎-S12-S1234(参考)": rules["◎-S12-S1234(スコア)"],
};
for (const [pn, rs] of Object.entries(pops6)) {
  console.log(`\n================ 7. 時点着順ルール: ${pn} ================`);
  for (const [rn, f] of Object.entries(pitRules)) {
    const a = sim(rs, f);
    const e = sim(rs.filter((r) => r.date < CLEAN), f, false);
    const l = sim(rs.filter((r) => r.date >= CLEAN), f, false);
    const ok = e.ex1 > 1 && l.ex1 > 1 && e.hits >= 15 && l.hits >= 15;
    console.log(
      `  ${rn.padEnd(20)} ROI${pc(a.roi)} ex1${pc(a.ex1)} ex3${pc(a.ex3)} [${pc(a.lo)},${pc(a.hi)}] h${a.hits}` +
        ` | 窓外${pc(e.roi)}/ex1${pc(e.ex1)} h${e.hits} | 窓内${pc(l.roi)}/ex1${pc(l.ex1)} h${l.hits}${ok ? "  ★PASS2" : ""}`,
    );
  }
}
