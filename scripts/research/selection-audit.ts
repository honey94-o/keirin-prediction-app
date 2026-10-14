/**
 * 【検証結果: 厳選(margin>=10)はどの買い方でもex-top-1で100%割れ。コメントの検証値の多くは
 *   1件の826倍的中に依存。試行した変種は約460通り（多重比較に注意）】
 * 1. margin十分位(全12,479R)：回収率はmarginと無関係にほぼ横ばい（CUR ex1 79〜127%、F2 66〜124%）。
 *    ◎1着率はmarginで単調に上がる（D1 28%→D10 76%）が配当が同じだけ下がる＝marginは
 *    「当たりやすさ」の指標であって「割安さ」の指標ではない。代替セレクタ探索280通りで
 *    train/test両方ex1>100%は3件のみ（◎syouritu上位30%×F3 ex1 114%等）だが、syouritu・ren3は
 *    現在のスナップショット（評価対象レース自身の結果を含む）なので先読みの疑いが強く不採用。
 *    厳選の上限10件/日は一度も発動していない（候補は最大7件/日、0件の日35/169）。
 * 2. ability-gap除外：現行(n277) ex1 78%(tr74/te69) vs 除外なし(n645) ex1 77%(tr73/te77)。
 *    除外される側の単体は現行買い目で回収76%(tr72/te81)と悪いが、F2固定では111%(tr120/te95)。
 *    コメントの「103.8%→145.2%」はex1では再現せず＝中立。判定不能（残しても害は小）。
 * 3. 予選除外：margin>=10の予選(n312)はCUR回収122% ex1 99%(tr103/te54)、F2固定では68%(tr60/te60)、
 *    ◎1着率は採用側と同じ80%。margin>=10では判定不能。margin<5では予選・9車側が約92%で
 *    非予選127%より明確に弱い。※raceStageが「ガ予１/ガ予２/男予２/ア予Ａ/二予Ｂ」等の略記を
 *    予選と判定できず（約700R）「チ準決」も準決勝扱いされないバグあり。9車除外：n11・0的中・
 *    ◎1着55%で維持（母数は小さい）。
 * 4. margin帯×買い方（厳選277R）：10-13 CUR ex1 73%(tr63/te70) 最良はF6 ex1 91%(tr77/te101)、
 *    13-16 CUR ex1 71%で全買い方赤字、16+ CUR ex1 61%で全買い方赤字（的中払戻の中央値540円）。
 *    全体ではF1(◎-pool0-pool1の1点) ex1 96%(tr86/te86)がCUR ex1 78%(tr74/te69)を両期間で上回るが
 *    100%未満。コメントの「10-13で119%/122%」は82,680円の1件込みの数字。
 *    グレード：F2開催 CUR ex1 91%(tr84/te79) vs F1以上 ex1 44%(tr46/te12)。全レースmargin>=5・F6
 *    固定でもF2 96% vs F1以上 80%（両期間同方向）。
 * 5. バリカタ（1点・的中率）：現行 n323 1.91件/日 的中26%(tr23/te33)。◎=先頭に限定すると
 *    n221 1.31件/日 31%(tr26/te40)、◎=番手は16%(tr15/te17)で月別でも7ヶ月中6ヶ月で先頭側が上。
 *    ◎先頭&margin>=6なら2.05件/日・28%(tr26/te33)、◎先頭&margin>=7で1.70件/日・30%(tr27/te35)。
 *    margin閾値を上げるほど的中率は単調に上がる（>=10で30%・1.04件/日）。並び替えの別案は改善なし。
 * 8. 逆に margin<5（現行の◎=対抗ボックス約5点）は全8,766R ex1 110%(tr107/te106) ex3 104%
 *    CI[102,130]、非予選・非9車に限ると ex1 121%(tr115/te115) ex3 112% CI[110,146]。
 *    ただし35R/日と多く、スナップショット統計の先読みで低配当帯以上に水増しされている可能性があり、
 *    ライブでの紙上検証が必要。
 *
 * 厳選・バリカタの「レース選定ルール」と、コード内コメントに書かれた検証値の再監査。
 * scored-cache.json（全確定12,479レースを本番predictRaceで再スコア）だけを使い、
 * 本番DBには一切接続しない。train/test境界は厳選ベースラインと同じ2026-07-26。
 * 各数値は「回収率 / 最大1件除外 / 最大3件除外 / 的中数」で、払戻の極端な裾を
 * 前提に ex-top-1 が train・test 両方で改善するかを採否の基準にする。
 *
 * 実行: npx tsx scripts/research/selection-audit.ts [section...]
 *   section = 1 2 3 4 5 6 7 8（省略時は全部）
 */
import {
  loadCache,
  isGensenCandidate,
  selectGensen,
  isBarikataCandidate,
  currentBarikataCombo,
  honmeiCombos,
  ABILITY_GAP_THIN_THRESHOLD,
  type CRace,
} from "../lib/research-cache";
import { raceStage } from "../../lib/scoring";

const CUT = "20260726";
const sections = new Set(process.argv.slice(2));
const want = (s: string) => sections.size === 0 || sections.has(s);

// ---------------------------------------------------------------- 集計ヘルパー
type Fn = (r: CRace) => string[];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Agg {
  n: number;
  points: number;
  hits: number;
  stake: number;
  ret: number;
  hitPays: number[];
  per: { s: number; p: number }[];
}
function agg(races: CRace[], fn: Fn): Agg {
  const a: Agg = { n: 0, points: 0, hits: 0, stake: 0, ret: 0, hitPays: [], per: [] };
  for (const r of races) {
    if (!r.hasOdds) continue;
    const c = fn(r);
    if (c.length === 0) continue;
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
const exTop = (a: Agg, k: number) =>
  a.stake ? (a.ret - a.hitPays.slice(0, k).reduce((s, x) => s + x, 0)) / a.stake : 0;
function bootCI(a: Agg, iters = 1000): [number, number] {
  if (a.per.length === 0) return [0, 0];
  const rnd = mulberry32(12345);
  const vals: number[] = [];
  const n = a.per.length;
  for (let i = 0; i < iters; i++) {
    let s = 0;
    let p = 0;
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
const train = (rs: CRace[]) => rs.filter((r) => r.date < CUT);
const test = (rs: CRace[]) => rs.filter((r) => r.date >= CUT);

interface Row {
  all: Agg;
  tr: Agg;
  te: Agg;
}
function row(races: CRace[], fn: Fn): Row {
  return { all: agg(races, fn), tr: agg(train(races), fn), te: agg(test(races), fn) };
}
/** 1行サマリー：全体(n/点/的中/回収/ex1/ex3/90%CI) | train(的中/回収/ex1) | test(同) */
function line(label: string, races: CRace[], fn: Fn, ci = true): Row {
  const x = row(races, fn);
  const a = x.all;
  const c = ci ? bootCI(a) : null;
  console.log(
    `  ${label.padEnd(26)} n=${String(a.n).padStart(5)} 点${(a.points / Math.max(1, a.n)).toFixed(1).padStart(4)}` +
      ` 的中${String(a.hits).padStart(4)} 回収${pct(roi(a)).padStart(5)} ex1 ${pct(exTop(a, 1)).padStart(4)} ex3 ${pct(exTop(a, 3)).padStart(4)}` +
      (c ? ` CI[${pct(c[0])},${pct(c[1])}]` : "") +
      ` | tr ${x.tr.hits}/${x.tr.n} ${pct(roi(x.tr))} ex1 ${pct(exTop(x.tr, 1))}` +
      ` | te ${x.te.hits}/${x.te.n} ${pct(roi(x.te))} ex1 ${pct(exTop(x.te, 1))}`
  );
  return x;
}
const passBoth = (x: Row) => exTop(x.tr, 1) > 1 && exTop(x.te, 1) > 1;

// ---------------------------------------------------------------- フォーメーション
const ax = (r: CRace) => r.entries[0].car;
function build(a: number, seconds: number[], thirds: number[]): string[] {
  const out: string[] = [];
  for (const s of seconds) for (const t of thirds) if (s !== t && s != null && t != null) out.push(`${a}-${s}-${t}`);
  return out;
}
const P = (r: CRace) => r.honmeiPool;
const F: Record<string, Fn> = {
  CUR: honmeiCombos,
  F1: (r) => build(ax(r), [P(r)[0]], [P(r)[1]]),
  F2: (r) => build(ax(r), [P(r)[0]], P(r).slice(1, 3)),
  F3: (r) => build(ax(r), [P(r)[0]], P(r).slice(1, 4)),
  F4: (r) => build(ax(r), P(r).slice(0, 2), P(r).slice(0, 3)),
  F6: (r) => build(ax(r), P(r).slice(0, 3), P(r).slice(0, 3)),
  F10: (r) => build(ax(r), P(r).slice(0, 2), P(r).slice(0, 8)).slice(0, 12),
  // 参考：プール順ではなく総合スコア順
  S1: (r) => build(ax(r), [r.entries[1]?.car], [r.entries[2]?.car]),
  S2: (r) => build(ax(r), [r.entries[1]?.car], [r.entries[2]?.car, r.entries[3]?.car].filter((x) => x != null)),
};

// ---------------------------------------------------------------- 特徴量
function tokGap(r: CRace): number | null {
  const h = r.entries[0].tokuten;
  const o = r.entries.slice(1).map((e) => e.tokuten);
  if (h == null || o.some((x) => x == null)) return null;
  return h - Math.max(...(o as number[]));
}
function closestRivalAttack(r: CRace): boolean {
  let c = r.entries[1];
  for (const o of r.entries.slice(1)) if ((o.tokuten ?? -1) > (c.tokuten ?? -1)) c = o;
  return c.kyaku === "逃" || c.kyaku === "両";
}
const lineSize = (r: CRace) =>
  r.entries[0].lineGroup == null ? 1 : r.entries.filter((e) => e.lineGroup === r.entries[0].lineGroup).length;
const cls = (r: CRace) => (r.entries[0].classRank ?? "?")[0];

const all = loadCache().filter((r) => r.entries.length >= 3 && r.honmeiPool.length >= 2);
const dates = new Set(all.map((r) => r.date)).size;
console.log(`対象 ${all.length}レース / ${dates}開催日 / train<${CUT}`);

// ================================================================= 1. selector
if (want("1")) {
  console.log("\n==== 1. 全レース：margin十分位 × フォーメーション ====");
  const sorted = [...all].sort((a, b) => a.margin - b.margin);
  for (const fname of ["CUR", "F2", "F6"]) {
    console.log(` [${fname}]`);
    for (let d = 0; d < 10; d++) {
      const part = sorted.slice(Math.floor((d * sorted.length) / 10), Math.floor(((d + 1) * sorted.length) / 10));
      const lo = part[0].margin.toFixed(1);
      const hi = part.at(-1)!.margin.toFixed(1);
      const winRate = part.filter((r) => r.actual.split("-")[0] === String(ax(r))).length / part.length;
      line(`D${d + 1} m${lo}-${hi} ◎1着${pct(winRate)}`, part, F[fname], false);
    }
  }

  console.log("\n==== 1b. 代替セレクタ探索（全レース、上位q%で切る）====");
  type Sel = { name: string; v: (r: CRace) => number | null };
  const sels: Sel[] = [
    { name: "margin", v: (r) => r.margin },
    { name: "tokGap", v: tokGap },
    { name: "◎tokuten", v: (r) => r.entries[0].tokuten },
    { name: "◎syouritu", v: (r) => r.entries[0].syouritu },
    { name: "◎ren3", v: (r) => r.entries[0].ren3 },
    { name: "margin×tokGap>0", v: (r) => ((tokGap(r) ?? -1) > 0 ? r.margin : null) },
    { name: "margin(男子のみ)", v: (r) => (r.girls ? null : r.margin) },
    { name: "margin(非予選)", v: (r) => (raceStage(r.syumoku) === "予選" ? null : r.margin) },
  ];
  const qs = [0.02, 0.05, 0.1, 0.2, 0.3];
  const fnames = ["CUR", "F1", "F2", "F3", "F4", "F6", "F10"];
  let tried = 0;
  const survivors: string[] = [];
  for (const s of sels) {
    const vals = all.map((r) => s.v(r)).filter((x): x is number => x != null).sort((a, b) => b - a);
    for (const q of qs) {
      const th = vals[Math.floor(vals.length * q)];
      const picked = all.filter((r) => {
        const v = s.v(r);
        return v != null && v >= th;
      });
      for (const fn of fnames) {
        tried++;
        const x = row(picked, F[fn]);
        if (passBoth(x)) {
          const c = bootCI(x.all);
          survivors.push(
            `  ${s.name} top${q * 100}%(>=${th.toFixed(1)}) ${fn}: n=${x.all.n} 的中${x.all.hits} 回収${pct(roi(x.all))} ex1 ${pct(exTop(x.all, 1))} ex3 ${pct(exTop(x.all, 3))} CI[${pct(c[0])},${pct(c[1])}] | tr ex1 ${pct(exTop(x.tr, 1))} (${x.tr.hits}) te ex1 ${pct(exTop(x.te, 1))} (${x.te.hits})`
          );
        }
      }
    }
  }
  console.log(`  試行数 ${tried}、train/test両方でex1>100%: ${survivors.length}件`);
  for (const s of survivors) console.log(s);

  console.log("\n  参考：主要セレクタ×F2/CURの上位10%");
  for (const s of sels.slice(0, 3)) {
    const vals = all.map((r) => s.v(r)).filter((x): x is number => x != null).sort((a, b) => b - a);
    const th = vals[Math.floor(vals.length * 0.1)];
    const picked = all.filter((r) => (s.v(r) ?? -1e9) >= th);
    line(`${s.name} top10% CUR`, picked, F.CUR);
    line(`${s.name} top10% F2`, picked, F.F2);
  }
}

// ================================================================= 2/3. exclusions
function cand(opts: { gap: boolean; yosen: boolean; nine: boolean; minMargin?: number }) {
  return (r: CRace) => {
    if (opts.yosen && raceStage(r.syumoku) === "予選") return false;
    if (opts.nine && r.entries.length === 9) return false;
    if (r.margin < (opts.minMargin ?? 10)) return false;
    if (opts.gap) {
      const g = tokGap(r);
      if (g != null && g < ABILITY_GAP_THIN_THRESHOLD && closestRivalAttack(r)) return false;
    }
    return true;
  };
}
if (want("2") || want("3")) {
  console.log("\n==== 2/3. 除外ルールの有無（margin>=10、本命シナリオの現行買い目）====");
  const prod = selectGensen(all);
  line("現行（3除外すべて）", prod, F.CUR);
  line("ability-gap除外なし", selectGensen(all, cand({ gap: false, yosen: true, nine: true })), F.CUR);
  line("予選除外なし", selectGensen(all, cand({ gap: true, yosen: false, nine: true })), F.CUR);
  line("9車除外なし", selectGensen(all, cand({ gap: true, yosen: true, nine: false })), F.CUR);
  line("除外なし", selectGensen(all, cand({ gap: false, yosen: false, nine: false })), F.CUR);
  console.log(" 除外された側の単体成績（margin>=10）");
  const m10 = all.filter((r) => r.margin >= 10);
  const gapEx = m10.filter((r) => {
    const g = tokGap(r);
    return raceStage(r.syumoku) !== "予選" && r.entries.length !== 9 && g != null && g < 5 && closestRivalAttack(r);
  });
  const gapTh = (th: number) =>
    m10.filter((r) => {
      const g = tokGap(r);
      return raceStage(r.syumoku) !== "予選" && r.entries.length !== 9 && g != null && g < th && closestRivalAttack(r);
    });
  line("gap<5×逃両 で除外", gapEx, F.CUR);
  for (const th of [0, 3, 8]) line(`  (参考)gap<${th}×逃両`, gapTh(th), F.CUR);
  line("予選で除外", m10.filter((r) => raceStage(r.syumoku) === "予選" && r.entries.length !== 9), F.CUR);
  line("9車で除外", m10.filter((r) => r.entries.length === 9), F.CUR);
  console.log(" 同じ除外をフォーメーション非依存（F2固定）でも");
  line("gap除外側 F2", gapEx, F.F2);
  line("予選除外側 F2", m10.filter((r) => raceStage(r.syumoku) === "予選" && r.entries.length !== 9), F.F2);
  line("9車除外側 F2", m10.filter((r) => r.entries.length === 9), F.F2);
  line("現行採用側 F2", prod, F.F2);
  console.log(" ◎1着率（＝予想の当たりやすさ）");
  const win = (rs: CRace[]) => {
    const w = rs.filter((r) => r.actual.split("-")[0] === String(ax(r))).length;
    return `${pct(w / rs.length)} (${w}/${rs.length})`;
  };
  console.log(`  採用 ${win(prod)} / gap除外 ${win(gapEx)} / 予選除外 ${win(m10.filter((r) => raceStage(r.syumoku) === "予選" && r.entries.length !== 9))} / 9車除外 ${win(m10.filter((r) => r.entries.length === 9))}`);
}

// ================================================================= 4. bands × formation
if (want("4")) {
  console.log("\n==== 4. 厳選候補（=選定。上限10件/日は一度も効いていない）margin帯 × フォーメーション ====");
  const g = selectGensen(all);
  for (const [lo, hi] of [
    [10, 13],
    [13, 16],
    [16, 999],
    [10, 999],
  ] as const) {
    const part = g.filter((r) => r.margin >= lo && r.margin < hi);
    console.log(` [margin ${lo}-${hi}]`);
    for (const fn of ["CUR", "F1", "F2", "F3", "F4", "F6", "F10", "S1", "S2"]) line(fn, part, F[fn]);
    const hp = agg(part, F.CUR).hitPays;
    console.log(`   CUR的中払戻（100円あたり、上位5）: ${hp.slice(0, 5).join(", ")} / 中央値 ${hp[Math.floor(hp.length / 2)]}`);
  }
  console.log(" 男子/ガールズ別（現行買い目）");
  line("男子", g.filter((r) => !r.girls), F.CUR);
  line("ガールズ", g.filter((r) => r.girls), F.CUR);
  line("男子 F2", g.filter((r) => !r.girls), F.F2);
  line("ガールズ F2", g.filter((r) => r.girls), F.F2);
}

// ================================================================= 5. barikata
if (want("5")) {
  console.log("\n==== 5. バリカタ（1点・的中率目的）====");
  const sameTop3 = (r: CRace) => {
    if (r.entries.length < 3 || r.entries.length === 9) return false;
    const [a, b, c] = r.entries;
    return a.lineGroup != null && a.lineGroup === b.lineGroup && b.lineGroup === c.lineGroup;
  };
  const RANK: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4 };
  const lineOrder = (r: CRace) => {
    const t = r.entries.slice(0, 3).sort((x, y) => (RANK[x.linePos ?? ""] ?? 99) - (RANK[y.linePos ?? ""] ?? 99));
    return [t.map((e) => e.car).join("-")];
  };
  const scoreOrder = (r: CRace) => [r.entries.slice(0, 3).map((e) => e.car).join("-")];
  const cur = (r: CRace) => [currentBarikataCombo(r)];
  function hr(label: string, rs: CRace[], fn: Fn = cur) {
    const h = (xs: CRace[]) => xs.filter((r) => fn(r).includes(r.actual)).length;
    const tr = train(rs);
    const te = test(rs);
    const p = h(rs) / Math.max(1, rs.length);
    const se = Math.sqrt((p * (1 - p)) / Math.max(1, rs.length));
    const a = agg(rs, fn);
    console.log(
      `  ${label.padEnd(30)} n=${String(rs.length).padStart(4)} ${(rs.length / dates).toFixed(2)}件/日 的中${pct(p)}±${pct(1.645 * se)}` +
        ` | tr ${pct(h(tr) / Math.max(1, tr.length))} (${h(tr)}/${tr.length}) | te ${pct(h(te) / Math.max(1, te.length))} (${h(te)}/${te.length})` +
        ` | 回収${pct(roi(a))} ex1 ${pct(exTop(a, 1))}`
    );
  }
  const base = all.filter(sameTop3);
  console.log(" 並び方（現行条件 margin>=8）");
  const cur8 = base.filter((r) => r.margin >= 8);
  hr("現行（◎→隊列順）", cur8, cur);
  hr("総合スコア順", cur8, scoreOrder);
  hr("3人を隊列順（◎無視）", cur8, lineOrder);
  console.log(" margin閾値");
  for (const m of [4, 6, 7, 8, 9, 10, 12, 15]) hr(`margin>=${m}`, base.filter((r) => r.margin >= m));
  console.log(" 追加条件（margin>=8）");
  for (const pos of ["先頭", "番手", "3番手"]) hr(`◎=${pos}`, cur8.filter((r) => r.entries[0].linePos === pos));
  hr("ライン3人ちょうど", cur8.filter((r) => lineSize(r) === 3));
  hr("ライン4人以上", cur8.filter((r) => lineSize(r) >= 4));
  hr("予選除外", cur8.filter((r) => raceStage(r.syumoku) !== "予選"));
  hr("予選のみ", cur8.filter((r) => raceStage(r.syumoku) === "予選"));
  hr("◎がtokuten最上位", cur8.filter((r) => (tokGap(r) ?? -1) > 0));
  hr("◎がtokuten最上位でない", cur8.filter((r) => (tokGap(r) ?? 1) <= 0));
  hr("gap<5×逃両（厳選の除外条件）", cur8.filter((r) => (tokGap(r) ?? 99) < 5 && closestRivalAttack(r)));
  hr("上記以外", cur8.filter((r) => !((tokGap(r) ?? 99) < 5 && closestRivalAttack(r))));
  for (const c of ["S", "A"]) hr(`◎${c}級`, cur8.filter((r) => cls(r) === c));
  hr("7車以下", cur8.filter((r) => r.entries.length <= 7));
  hr("8車", cur8.filter((r) => r.entries.length === 8));
  console.log(" ◎先頭の時の並び方");
  const sente = cur8.filter((r) => r.entries[0].linePos === "先頭");
  hr("◎先頭 現行", sente, cur);
  hr("◎先頭 スコア順", sente, scoreOrder);
  const nonSente = cur8.filter((r) => r.entries[0].linePos !== "先頭");
  hr("◎非先頭 現行", nonSente, cur);
  hr("◎非先頭 隊列順(◎無視)", nonSente, lineOrder);
  hr("◎非先頭 スコア順", nonSente, scoreOrder);
}

// ================================================================= 6. misc
if (want("6")) {
  console.log("\n==== 6. その他 ====");
  const g = selectGensen(all);
  const perDay = new Map<string, number>();
  for (const r of all.filter(isGensenCandidate)) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
  console.log(`  厳選候補の1日最大件数 ${Math.max(...perDay.values())}（上限10件は未発動）、0件の日 ${dates - perDay.size}/${dates}`);
  console.log(" ◎1着率 by margin（HIGH_CONFIDENCE_MARGINコメントの『10-20で81.7%』確認）");
  for (const [lo, hi] of [
    [0, 5],
    [5, 10],
    [10, 13],
    [13, 16],
    [16, 20],
    [20, 999],
  ] as const) {
    const p = all.filter((r) => r.margin >= lo && r.margin < hi);
    const w = p.filter((r) => r.actual.split("-")[0] === String(ax(r))).length;
    console.log(`  m${lo}-${hi}: ◎1着 ${pct(w / p.length)} (${w}/${p.length})`);
  }
  console.log(" グレード別・段階別（現行厳選）");
  for (const gr of ["F2", "F1", "G3", "G2", "G1"]) {
    const p = g.filter((r) => r.grade === gr);
    if (p.length) line(gr, p, F.CUR);
  }
  for (const st of ["一般", "選抜・特選", "準決勝", "決勝", "その他"]) {
    const p = g.filter((r) => raceStage(r.syumoku) === st);
    if (p.length) line(st, p, F.CUR);
  }
  console.log(" 月別（現行厳選）＝期間の偏り確認");
  for (const m of [...new Set(g.map((r) => r.date.slice(0, 6)))]) line(m, g.filter((r) => r.date.startsWith(m)), F.CUR, false);
}

// ================================================================= 7. 追加の深掘り
if (want("7")) {
  console.log("\n==== 7. 深掘り：厳選のグレード/級班、バリカタの組み合わせ条件 ====");
  const g = selectGensen(all);
  const synStats = new Map<string, number>();
  for (const r of g.filter((r) => raceStage(r.syumoku) === "その他")) {
    const k = (r.syumoku ?? "").replace(/ナイター|ミッドナイト|モーニング|\s/g, "");
    synStats.set(k, (synStats.get(k) ?? 0) + 1);
  }
  console.log("  段階『その他』の種目:", [...synStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(" "));
  for (const c of ["S", "A", "L"]) {
    const p = g.filter((r) => cls(r) === c);
    for (const fn of ["CUR", "F1", "F6"]) line(`◎${c}級 ${fn}`, p, F[fn]);
  }
  for (const gr of [["F2"], ["F1", "G3", "G2", "G1"]]) {
    const p = g.filter((r) => gr.includes(r.grade ?? ""));
    for (const fn of ["CUR", "F1", "F6"]) line(`${gr.join("/")} ${fn}`, p, F[fn]);
  }
  // 全レースでもF2開催 vs それ以外の差があるか（厳選以外でも再現するか）
  console.log("  全レース（margin>=5）でのグレード差（F6固定）");
  const m5 = all.filter((r) => r.margin >= 5);
  line("F2開催 m>=5", m5.filter((r) => r.grade === "F2"), F.F6);
  line("F1以上 m>=5", m5.filter((r) => r.grade !== "F2"), F.F6);

  console.log("  バリカタ：◎先頭を軸にした組み合わせ（1点・現行並び）");
  const sameTop3 = (r: CRace) => {
    if (r.entries.length < 3 || r.entries.length === 9) return false;
    const [a, b, c] = r.entries;
    return a.lineGroup != null && a.lineGroup === b.lineGroup && b.lineGroup === c.lineGroup;
  };
  const base = all.filter(sameTop3);
  const hit = (rs: CRace[]) => rs.filter((r) => currentBarikataCombo(r) === r.actual).length;
  const hr = (label: string, rs: CRace[]) => {
    const tr = train(rs);
    const te = test(rs);
    const a = agg(rs, (r) => [currentBarikataCombo(r)]);
    console.log(
      `  ${label.padEnd(30)} n=${String(rs.length).padStart(4)} ${(rs.length / dates).toFixed(2)}件/日 的中${pct(hit(rs) / rs.length)}` +
        ` | tr ${pct(hit(tr) / tr.length)} (${hit(tr)}/${tr.length}) | te ${pct(hit(te) / te.length)} (${hit(te)}/${te.length}) | 回収${pct(roi(a))} ex1 ${pct(exTop(a, 1))}`
    );
  };
  for (const m of [6, 7, 8, 10]) hr(`◎先頭 & margin>=${m}`, base.filter((r) => r.margin >= m && r.entries[0].linePos === "先頭"));
  for (const m of [6, 8]) hr(`◎先頭 & tok最上位 & m>=${m}`, base.filter((r) => r.margin >= m && r.entries[0].linePos === "先頭" && (tokGap(r) ?? -1) > 0));
  for (const m of [8, 10, 12]) hr(`◎番手 & margin>=${m}`, base.filter((r) => r.margin >= m && r.entries[0].linePos === "番手"));
  // 月別の安定性（◎先頭 m>=8）
  const s8 = base.filter((r) => r.margin >= 8 && r.entries[0].linePos === "先頭");
  const n8 = base.filter((r) => r.margin >= 8 && r.entries[0].linePos !== "先頭");
  console.log("  月別 的中率 ◎先頭 vs ◎非先頭（margin>=8）");
  for (const m of [...new Set(base.map((r) => r.date.slice(0, 6)))].sort()) {
    const a = s8.filter((r) => r.date.startsWith(m));
    const b = n8.filter((r) => r.date.startsWith(m));
    console.log(`   ${m}: 先頭 ${hit(a)}/${a.length}  非先頭 ${hit(b)}/${b.length}`);
  }
  // ◎番手のとき実際の1着は誰か
  const who = new Map<string, number>();
  for (const r of n8) {
    const w = r.entries.find((e) => String(e.car) === r.actual.split("-")[0]);
    const k = w === r.entries[0] ? "◎" : w && w.lineGroup === r.entries[0].lineGroup ? `同ライン${w.linePos}` : "他ライン";
    who.set(k, (who.get(k) ?? 0) + 1);
  }
  console.log("  ◎非先頭のバリカタで実際の1着:", [...who.entries()].map(([k, v]) => `${k}${v}`).join(" "));
}

// ================================================================= 8. margin帯（厳選外）の現行買い目
if (want("8")) {
  console.log("\n==== 8. 厳選外のmargin帯（本命シナリオ現行買い目）====");
  const nonYosen = (r: CRace) => raceStage(r.syumoku) !== "予選" && r.entries.length !== 9;
  for (const [lo, hi] of [
    [0, 5],
    [5, 10],
    [10, 999],
  ] as const) {
    const p = all.filter((r) => r.margin >= lo && r.margin < hi);
    line(`m${lo}-${hi} 全`, p, F.CUR);
    line(`m${lo}-${hi} F2開催`, p.filter((r) => r.grade === "F2"), F.CUR);
    line(`m${lo}-${hi} F1以上`, p.filter((r) => r.grade !== "F2"), F.CUR);
    line(`m${lo}-${hi} 非予選・非9車`, p.filter(nonYosen), F.CUR);
  }
}
