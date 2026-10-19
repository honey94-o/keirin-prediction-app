/**
 * 【検証結果: 採用候補 ＝ 現行バリカタ候補のうち「Spure = P_pure(◎1着) × p(最上位ペア|◎1着)」が
 *   しきい値以上のものだけ残す。walk-forward（目標1.0/日）で P2 31.6→48.5%（16/33, 0.80/日）、
 *   P3 38.7→49.2%（31/63, 0.95/日）。P1（逆向き係数・参考）も同様（選ばれた側32.8% vs 落とした側14.3%）。
 *   候補内で選んだ側と落とした側の差は P2 48.5 vs 18.6%（z=2.8）、P3 49.2 vs 25.0%（z=2.6）。
 *   件数を現状（約1.8件/日）に保ったまま的中率を上げる方法は見つからなかった（母集団の拡大・ガールズは全部不採用）】
 *
 * バリカタ＝3連単1点（◎-2着-3着）。目的は的中率（回収率は参考）。現行ルール＝compute-picks.ts（margin>=8・
 * 9車除外・予想1-2-3位が同ライン、2・3着はPIT 2・3着モデルの最上位ペア）。男子の2・3着モデルは
 * walk-forwardで学習し直したもの（P2用=P1で学習、P3用=P1+P2で学習、P1用=P2+P3で学習した逆向き＝参考）。
 * 開催日 P1=67 / P2=41 / P3=66。的中率は全候補レース（全件オッズ有り）、回収率は100円/点。
 * 整合チェック：P3 男子◎1着 pair@1 25.8%（gensen-design-pit.ts 25.5%。キャッシュが10/19まで伸びた分の差）。
 *
 * ■ 0. ベースライン（現行ルール）          P1(参考)            P2                    P3
 *   現行条件×モデル最上位ペア（本番）   33/144 22.9% 2.15/日  24/76 31.6% 1.85/日  43/111 38.7% 1.68/日   回収 P2 113% / P3 175%
 *   参考：旧隊列順                      26/144 18.1%          22/76 28.9%           39/111 35.1%
 *   参考：候補内の◎1着率                66.0%                 76.3%                 82.0%
 *   ※◎1着率が P1→P3 と上がるのはracersスナップショットのリーク（評価期間が今に近いほど未来情報が
 *     多く混ざる）と整合的。絶対水準は本番で出る値より楽観的。特にP3。比較は「同じ◎同士の相対差」で見ること。
 *
 * ■ 1. 仮説1：2・3着モデルの確信度 p1 = p(最上位ペア|◎1着)（現行候補内）
 *   walk-forwardしきい値（P以前で件/日を合わせる）: 目標1.5/日 → P2 36.4%(16/44) P3 43.2%(35/81)
 *     目標1.2 → P2 33.3%(10/30, 0.73/日) P3 51.7%(31/60)、目標1.0 → P2 33.3% P3 52.0%
 *   → P3では大きく効くが、P2ではベースライン+2〜5ptだけ。gap(p1−2番目)も同程度（gap>=0.15 固定: 40.9/47.1%）。単独では弱い。
 *
 * ■ 2. 仮説2：P(◎1着) を出走全員の条件付きlogitで推定（特徴＝並び＋時点成績のみ。詳細はwinFeatureRows）
 *   男子全R の◎1着AUC: Pw 0.70/0.61/0.61（P1/P2/P3）、margin(リーク込み) 0.62/0.63/0.65。
 *   1点の的中AUC（S=Pw×p1）: 男子全R 0.75/0.66/0.70、現行候補内 0.67/0.70/0.68。
 *   pure版（「◎であること」を特徴に入れない完全時点モデル）も Pw と同じ識別力（AUC差<0.02）。
 *   現行候補内・walk-forwardしきい値（P以前の件/日で決める）:
 *                         P2                       P3                       P2+P3   回収(P2/P3)
 *     Spure 目標1.5/日    21/55 38.2% 1.34/日      39/94 41.5% 1.42/日      40.3%   123/146%
 *     Spure 目標1.2/日    21/47 44.7% 1.15/日      33/75 44.0% 1.14/日      44.3%   144/112%
 *     Spure 目標1.0/日    16/33 48.5% 0.80/日      31/63 49.2% 0.95/日      49.0%   146/111%
 *     S(isH込) 目標1.0    16/31 51.6% 0.76/日      31/63 49.2% 0.95/日      50.0%   145/111%
 *     Pw単独 目標1.0      17/38 44.7% 0.93/日      31/71 43.7% 1.08/日      44.0%
 *     Spure 目標0.7/日     9/23 39.1% 0.56/日      25/43 58.1% 0.65/日      51.5%   （P2がn=23で崩れる）
 *     日次上位1件(Spure)  11/32 34.4% 0.78/日      25/51 49.0% 0.77/日      （しきい値方式より劣る）
 *   参考：PITモデルの1着予想1位≠◎ の候補は P1 3/23・P2 0/11・P3 1/3 とほぼ全滅（Spureで自然に落ちる）。
 *
 * ■ 3. 仮説3：母集団を広げる → 全部不採用
 *   候補漏れ(m>=8・非同ライン): 全体 15.6/20.8%、S>=0.2 でも P2 22.5% P3 32.9%（同じSの候補より明確に低い）。
 *   margin<8: S>=0.25 でも P2 24.6% P3 29.0%。男子全R をSpureのwalk-forwardしきい値で選ぶ（目標2/日）:
 *   P2 28.9% P3 37.2%、目標1/日: P2 34.2% P3 52.5% → P2で現行候補∧Spureに大きく劣る。同ライン条件は有効。
 *   ガールズ1点（◎-honmeiPool上位2）: 全体 11.2/9.1/11.7%、Pw上位(目標0.3/日)でも P2 1/6 P3 6/23。不採用。
 *
 * ■ 4. 仮説4：除外条件（現行候補内のセグメント別。P1/P2/P3）
 *   ◎位置=番手  14.6/21.1/23.3%（先頭 27.1/35.1/44.4%）  ← 3期間とも一貫して低い
 *   grade=F1    19.2/18.2/26.5%（F2 25.6/37.7/44.2%）     ← 3期間とも一貫して低い
 *   stage・頭数・ライン数・単騎数・margin帯は期間で順位が入れ替わる（一貫性なし）。
 *   walk-forward除外（P以前でn>=20・z<=-1.5）: P3でだけ F1・番手 が検出され P3 44.2/44.4%。P2用（P1のみ）では
 *   検出されず、代わりに 一般・ライン数4・単騎2 を誤検出して P2 が悪化（29.8/28.8/29.4%）。→ 汎用の除外探索は不採用。
 *   固定の 候補∧◎先頭（期間を見て選んだもの＝参考）: 35.1/44.4% 1.39/1.23件/日。
 *   候補∧◎先頭∧Spure(wf) 目標1.0: P2 48.6%(17/35) P3 50.9%(29/57)、目標0.8: P2 50.0%(15/30, 0.73/日) P3 56.0%(28/50, 0.76/日)。
 *   → ◎先頭の上乗せはSpure単独と同程度（Spureが番手◎を既に下げている）。入れるなら0.8/日帯のみ。
 *
 * ■ 推奨ルール（現行バリカタ条件はそのまま、その上に追加）
 *   Spure = P_pure(◎1着) × secondThird[0].p >= T   （◎ = scored[0]）
 *   ・secondThird[0].p は本番 predictRace が既に計算している PITモデルの最上位ペア確率（lib/second-third-model.ts）。
 *   ・P_pure(◎1着) は出走全員の softmax( Σ WIN_PURE_COEFS[f]·x_f(c) ) の◎の値。x はこのファイルの
 *     winFeatureRows(pe, ◎, girls=false, withH=false)。入力は predict.ts が pitEntries 用に作っている
 *     {car, lineGroup, linePos, form=computeForm(getPitHistories…)} だけ（追加のDBクエリ不要）。
 *     cat = 同ライン人数<=1かline_group NULL→K、先頭→L、番手→S、それ以外→T。
 *     特徴: catL, catS, catT, L_big(=L∧ライン3車以上), S_big, car1to3, fWin, fTop2, fTop3, fFin, fRec3,
 *       fPosTop2(=form.posTop2[cat]), fNige, fMakuri, fSashi, fMark, fLead, fNewbie(nPrior<5),
 *       L_nige(=L×nige), S_frontTop2(=S×直前の同ライン選手のtop2), S_frontNige(=S×直前選手のnige), S_sashi(=S×sashi)
 *   ・WIN_PURE_COEFS（男子9車除外の全期間で学習）: catL 0.06888, catS -0.32059, catT -0.59772, L_big 0.47523,
 *     S_big 0.93993, car1to3 0.20110, fWin 2.61938, fTop2 1.54790, fTop3 -0.19001, fFin -2.32164, fRec3 1.27989,
 *     fPosTop2 0.61509, fNige 0.50411, fMakuri 0.51708, fSashi -0.29173, fMark -1.78166, fLead 0.50022,
 *     fNewbie 0.03656, L_nige -1.08459, S_frontTop2 1.04688, S_frontNige 1.09292, S_sashi -0.55504
 *   ・T（本番係数PIT_MEN_COEFS＋上の係数で全期間の件/日を合わせたもの）:
 *       T=0.14 → 約1.0件/日（walk-forward 48.5/49.2%）← 推奨
 *       T=0.12 → 約1.2件/日（walk-forward 目標1.2: 44.7/44.0%）
 *       T=0.16 → 約0.85件/日（in-sample 35.1/48.5/55.4%。さらに◎先頭に絞る案は walk-forward 0.75件/日で 50.0/56.0%）
 *     （in-sample の固定T: 0.14 で P1 31.9% P2 47.6% P3 48.5%、0.12 で 32.9/42.9/44.7%）
 *   T未満になった同ライン候補は barikata_near_misses 側に回すなどの表示上の扱いは別途。
 *
 * ■ 注意
 *   ・候補母集団（margin・同ライン判定）と◎の決め方はリーク込みのまま。Spure自体は時点情報だけで、
 *     改善幅は「同じ◎・同じ候補の中での相対差」として読むこと。絶対的中率（約49%）は本番では下がる見込み。
 *   ・各期間 n=30〜65 なので±8pt程度の誤差がある。目標0.7/日以下は P2 で崩れる（ノイズ）。
 *   ・回収率は目的外。Spure目標1.0: P2 146%(ex1 121%) / P3 111%(ex1 105%)、現行 113%(ex1 99%) / 175%(ex1 138%)。
 *     P3の現行の高回収は低Spureレースの高配当によるもので、的中率優先なら落としてよい。
 *   ・entries.at_* スナップショットは10/15以降のみで検証には使えない。導入後は実運用の的中率で T を見直すこと。
 *
 * 実行: npx tsx scripts/research/barikata-hitrate.ts   （本番DBには接続しない。scored-cache.json と local.sqlite のみ）
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCache, isBarikataCandidate, currentBarikataCombo, BARIKATA_MIN_MARGIN, type CRace } from "../lib/research-cache";
import { raceStage } from "../../lib/scoring";
import { PIT_MEN_COEFS } from "../../lib/second-third-model";
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

// ================================================================ 時点履歴（gensen-design-pit.tsと同一）
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
const peCache = new Map<number, PitEntry[]>();
const entriesOf = (r: CRace): PitEntry[] => {
  let pe = peCache.get(r.raceId);
  if (!pe) peCache.set(r.raceId, (pe = r.entries.map((e) => ({ car: e.car, lineGroup: e.lineGroup, linePos: e.linePos, form: formOf(e.snum, r.date) }))));
  return pe;
};

// ================================================================ 条件付きlogit（Newton + L2、gensen-design-pit.tsと同一）
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

// ---------------------------------------------------------------- 2・3着モデル（walk-forward、gensen-design-pit.tsと同一）
interface Sample { r: CRace; si: number; ti: number; pe: PitEntry[] }
function pairSamples(races: CRace[]): Sample[] {
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
function fitPairCoefs(S: Sample[]): PitCoefs {
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

// ---------------------------------------------------------------- 1着モデル（新規：仮説2）
// 出走全員を選択肢とする条件付きlogit。特徴はその日の並び（ライン構造）と時点成績(PIT form)だけ。
// isH* は「◎（totalScore1位）であること」の補正項で、◎の選び方（racersスナップショット依存＝バックテストでは
// リーク込み）をそのまま定数ブーストとして吸収するだけ。レース間の順位付けは◎とライバルのPIT成績・
// 並びの差だけで決まる。pure版はisH*を持たない完全な時点モデル。
const POS_NUM: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4, "5番手": 5, "6番手": 6 };
const posNum = (p: string | null) => POS_NUM[p ?? ""] ?? 1;
const WIN_F_MEN = [
  "catL", "catS", "catT", "L_big", "S_big", "car1to3",
  "fWin", "fTop2", "fTop3", "fFin", "fRec3", "fPosTop2", "fNige", "fMakuri", "fSashi", "fMark", "fLead", "fNewbie",
  "L_nige", "S_frontTop2", "S_frontNige", "S_sashi",
  "isH", "isH_L", "isH_S",
] as const;
const WIN_F_GIRLS = ["car1to3", "fWin", "fTop2", "fTop3", "fFin", "fRec3", "fNige", "fMakuri", "fSashi", "fMark", "fNewbie", "isH"] as const;
function winFeatureRows(pe: PitEntry[], honmeiCar: number, girls: boolean, withH: boolean): number[][] {
  const lineSize = new Map<number, number>();
  for (const e of pe) if (e.lineGroup != null) lineSize.set(e.lineGroup, (lineSize.get(e.lineGroup) ?? 0) + 1);
  return pe.map((c) => {
    const f = c.form;
    const isH = withH && c.car === honmeiCar ? 1 : 0;
    if (girls) return [c.car <= 3 ? 1 : 0, f.win, f.top2, f.top3, f.finNorm, f.rec3, f.nige, f.makuri, f.sashi, f.mark, f.nPrior < 5 ? 1 : 0, isH];
    const ls = c.lineGroup != null ? lineSize.get(c.lineGroup) ?? 1 : 1;
    const cat: PosCat = ls <= 1 ? "K" : c.linePos === "先頭" ? "L" : c.linePos === "番手" ? "S" : "T";
    const L = cat === "L" ? 1 : 0, S = cat === "S" ? 1 : 0, T = cat === "T" ? 1 : 0;
    const front = cat === "S" || cat === "T" ? pe.find((o) => o.lineGroup === c.lineGroup && posNum(o.linePos) === posNum(c.linePos) - 1) : undefined;
    return [
      L, S, T, L * (ls >= 3 ? 1 : 0), S * (ls >= 3 ? 1 : 0), c.car <= 3 ? 1 : 0,
      f.win, f.top2, f.top3, f.finNorm, f.rec3, f.posTop2[cat], f.nige, f.makuri, f.sashi, f.mark, f.leadFreq, f.nPrior < 5 ? 1 : 0,
      L * f.nige, S * (front ? front.form.top2 : 0), S * (front ? front.form.nige : 0), S * f.sashi,
      isH, isH * L, isH * S,
    ];
  });
}
type WinCoefs = number[];
function fitWin(races: CRace[], girls: boolean, withH: boolean): WinCoefs {
  const groups: Group[] = [];
  for (const r of races) {
    if (r.deadHeat || r.entries.length < 3) continue;
    const w = Number(r.actual.split("-")[0]);
    const pe = entriesOf(r);
    const y = pe.findIndex((e) => e.car === w);
    if (y < 0) continue;
    groups.push({ X: winFeatureRows(pe, r.entries[0].car, girls, withH), y });
  }
  return fit(groups, (girls ? WIN_F_GIRLS : WIN_F_MEN).length);
}
function winProbs(r: CRace, w: WinCoefs, withH: boolean): number[] {
  return sm(winFeatureRows(entriesOf(r), r.entries[0].car, r.girls, withH), w);
}

// ================================================================ 期間・モデル
type Period = "P1" | "P2" | "P3";
const PERIODS: Period[] = ["P1", "P2", "P3"];
const period = (d: string): Period => (d < P2_START ? "P1" : d < P3_START ? "P2" : "P3");
const trainFilter: Record<Period, (d: string) => boolean> = {
  P1: (d) => d >= P2_START, // 逆向き（参考）
  P2: (d) => d < P2_START,
  P3: (d) => d < P3_START,
};
const all = loadCache().filter((r) => r.entries.length >= 3);
const days: Record<string, number> = { P1: 0, P2: 0, P3: 0 };
for (const d of new Set(all.map((r) => r.date))) days[period(d)]++;
const non9 = all.filter((r) => r.entries.length !== 9);
const men = non9.filter((r) => !r.girls);
const girls = non9.filter((r) => r.girls);
console.log(`races=${all.length} 9車除外 男子${men.length} ガールズ${girls.length}  開催日 P1=${days.P1} P2=${days.P2} P3=${days.P3}`);

const t0 = Date.now();
const menPairS = pairSamples(all.filter((r) => !r.girls));
const pairCoefs = {} as Record<Period, PitCoefs>;
const winMen = {} as Record<Period, WinCoefs>;
const winMenPure = {} as Record<Period, WinCoefs>;
const winGirls = {} as Record<Period, WinCoefs>;
for (const p of PERIODS) {
  pairCoefs[p] = fitPairCoefs(menPairS.filter((s) => trainFilter[p](s.r.date)));
  winMen[p] = fitWin(men.filter((r) => trainFilter[p](r.date)), false, true);
  winMenPure[p] = fitWin(men.filter((r) => trainFilter[p](r.date)), false, false);
  winGirls[p] = fitWin(girls.filter((r) => trainFilter[p](r.date)), true, true);
}
console.log(`fit done ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`1着モデル係数(P3用=P1+P2学習, 男子): ${WIN_F_MEN.map((f, i) => `${f} ${winMen.P3[i].toFixed(2)}`).join(", ")}`);
console.log(`1着モデル係数(P3用, ガールズ): ${WIN_F_GIRLS.map((f, i) => `${f} ${winGirls.P3[i].toFixed(2)}`).join(", ")}`);

// ---------------------------------------------------------------- レースごとのスコア（coef set ごと）
interface Score {
  combo: string; // 1点（男子=◎-モデル最上位ペア、ガールズ=本命シナリオ先頭=◎-pool[0]-pool[1]）
  p1: number; // P(top pair | ◎1着)（ガールズはNaN）
  gap: number; // p1 - p(2番目のペア)
  pw: number; // P(◎1着)（isH込み）
  pwPure: number; // P(◎1着)（isH無し＝完全時点モデル）
  pitFav: boolean; // pure版の1着確率1位が◎
  s: number; // pw * p1（ガールズはpw）
}
const scoreCache = new Map<string, Score>();
function score(r: CRace, set: Period): Score {
  const key = `${r.raceId}:${set}`;
  let s = scoreCache.get(key);
  if (s) return s;
  const h = r.entries[0].car;
  const hi = entriesOf(r).findIndex((e) => e.car === h);
  if (r.girls) {
    const pw = winProbs(r, winGirls[set], true)[hi];
    const pool = r.honmeiPool.filter((x) => x !== h);
    const pure = sm(winFeatureRows(entriesOf(r), h, true, false), winGirls[set]);
    s = { combo: `${h}-${pool[0]}-${pool[1]}`, p1: NaN, gap: NaN, pw, pwPure: pure[hi], pitFav: pure[hi] === Math.max(...pure), s: pw };
  } else {
    const pp = pairProbabilities(entriesOf(r), h, pairCoefs[set], { girls: false });
    const pw = winProbs(r, winMen[set], true)[hi];
    const pure = winProbs(r, winMenPure[set], false);
    s = { combo: `${h}-${pp[0].second}-${pp[0].third}`, p1: pp[0].p, gap: pp[0].p - pp[1].p, pw, pwPure: pure[hi], pitFav: pure[hi] === Math.max(...pure), s: pw * pp[0].p };
  }
  scoreCache.set(key, s);
  return s;
}
const wf = (r: CRace) => score(r, period(r.date));

// 整合チェック（gensen-design-pit.ts: P3 男子 pair@1 25.5）
{
  const te = menPairS.filter((s) => period(s.r.date) === "P3");
  let p1 = 0;
  for (const s of te) if (wf(s.r).combo === s.r.actual) p1++;
  console.log(`整合チェック P3 男子◎1着 pair@1 ${((p1 / te.length) * 100).toFixed(1)}% (n=${te.length})`);
}

// ================================================================ 集計
type Pick = (r: CRace) => string | null;
interface St { n: number; hits: number; nOdds: number; stake: number; ret: number; maxPay: number }
function st(races: CRace[], pick: Pick): St {
  const a: St = { n: 0, hits: 0, nOdds: 0, stake: 0, ret: 0, maxPay: 0 };
  for (const r of races) {
    const c = pick(r);
    if (c == null) continue;
    a.n++;
    const hit = c === r.actual;
    if (hit) a.hits++;
    if (r.hasOdds) {
      a.nOdds++;
      a.stake += 100;
      if (hit && r.payout != null) {
        a.ret += r.payout;
        a.maxPay = Math.max(a.maxPay, r.payout);
      }
    }
  }
  return a;
}
const pc = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
function cell(a: St, d: number): string {
  if (!a.n) return "n=0".padEnd(36);
  return `${String(a.hits).padStart(3)}/${String(a.n).padEnd(4)}${pc(a.hits / a.n).padStart(6)} ${(a.n / d).toFixed(2)}/日 回収${pc(a.stake ? a.ret / a.stake : 0, 0).padStart(4)}(ex1 ${pc(a.stake ? (a.ret - a.maxPay) / a.stake : 0, 0)})`;
}
/** 期間別の1行。P1は参考（2・3着/1着モデルはP2+P3で学習した逆向き） */
function row(label: string, races: CRace[], pick: Pick, show: Period[] = PERIODS) {
  const parts = show.map((p) => `${p} ${cell(st(races.filter((r) => period(r.date) === p), pick), days[p])}`);
  const both = st(races.filter((r) => r.date >= P2_START), pick);
  console.log(`  ${label.padEnd(30)} ${parts.join(" | ")} | P2+P3 ${pc(both.n ? both.hits / both.n : 0)}`);
}
const modelCombo: Pick = (r) => wf(r).combo;

// ================================================================ 0. ベースライン
const cand = men.filter(isBarikataCandidate);
console.log("\n==== 0. ベースライン（現行バリカタ条件：margin>=8・9車除外・予想1-2-3位同ライン）");
row("現行条件×モデル最上位ペア(本番)", cand, modelCombo);
row("参考 現行条件×旧隊列順", cand, (r) => currentBarikataCombo(r));
row("参考 ◎1着率", cand, (r) => (r.actual.split("-")[0] === String(r.entries[0].car) ? r.actual : "x"));

// ================================================================ 1. 仮説1：モデル確信度（p1 / gap）
console.log("\n==== 1. 仮説1：現行候補 × top pair確率 p1 >= t（固定しきい値の曲線。wf係数）");
for (const t of [0, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) row(`p1>=${t}`, cand, (r) => (wf(r).p1 >= t ? wf(r).combo : null));
for (const t of [0.05, 0.1, 0.15, 0.2, 0.25]) row(`gap>=${t}`, cand, (r) => (wf(r).gap >= t ? wf(r).combo : null));

// ================================================================ 2. 仮説2：P(◎1着)
function auc(xs: { s: number; y: boolean }[]): number {
  const pos = xs.filter((x) => x.y).map((x) => x.s), neg = xs.filter((x) => !x.y).map((x) => x.s);
  let c = 0;
  for (const a of pos) for (const b of neg) c += a > b ? 1 : a === b ? 0.5 : 0;
  return c / Math.max(1, pos.length * neg.length);
}
console.log("\n==== 2. 仮説2：P(◎1着)モデル（walk-forward）の識別力");
for (const [nm, pool] of [["男子9車除外全R", men], ["現行候補", cand], ["ガールズ全R", girls]] as const) {
  for (const p of PERIODS) {
    const rs = pool.filter((r) => period(r.date) === p && !r.deadHeat);
    const ys = rs.map((r) => ({ r, y: r.actual.split("-")[0] === String(r.entries[0].car) }));
    const won = ys.filter((x) => x.y).length;
    const meanPw = rs.reduce((a, r) => a + wf(r).pw, 0) / Math.max(1, rs.length);
    const a1 = auc(ys.map((x) => ({ s: wf(x.r).pw, y: x.y })));
    const a2 = auc(ys.map((x) => ({ s: wf(x.r).pwPure, y: x.y })));
    const a3 = nm === "ガールズ全R" ? NaN : auc(ys.map((x) => ({ s: x.r.margin, y: x.y })));
    const comboHit = rs.filter((r) => wf(r).combo === r.actual).length;
    const a4 = auc(rs.map((r) => ({ s: wf(r).s, y: wf(r).combo === r.actual })));
    console.log(
      `  ${nm.padEnd(12)} ${p} n=${rs.length} ◎1着${pc(won / Math.max(1, rs.length))} 平均Pw${pc(meanPw)} AUC(◎1着): Pw ${a1.toFixed(3)} pure ${a2.toFixed(3)} margin(リーク込み) ${a3.toFixed(3)} | 1点的中${comboHit} AUC(的中): S ${a4.toFixed(3)}`
    );
  }
}
console.log("\n  現行候補 × 各スコアの上位を残す（固定しきい値の曲線）");
for (const t of [0, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) row(`Pw>=${t}`, cand, (r) => (wf(r).pw >= t ? wf(r).combo : null));
for (const t of [0.12, 0.15, 0.18, 0.2, 0.22, 0.25]) row(`S=Pw*p1>=${t}`, cand, (r) => (wf(r).s >= t ? wf(r).combo : null));
row(`PIT1着1位=◎`, cand, (r) => (wf(r).pitFav ? wf(r).combo : null));
row(`PIT1着1位≠◎`, cand, (r) => (!wf(r).pitFav ? wf(r).combo : null));

// ================================================================ walk-forward しきい値（件/日目標）
// 期間Pのしきい値は「Pの係数（=P以前で学習）でP以前のレースを採点（in-sample）」した分布から、
// P以前の件/日が目標になるよう決める。P1は対象外（逆向き係数のため）。
function wfThreshold(pool: CRace[], key: (s: Score) => number, target: number, p: Period): number {
  const prior = pool.filter((r) => r.date < (p === "P2" ? P2_START : P3_START));
  const pd = p === "P2" ? days.P1 : days.P1 + days.P2;
  const v = prior.map((r) => key(score(r, p))).filter((x) => Number.isFinite(x)).sort((a, b) => b - a);
  const k = Math.round(target * pd);
  if (k <= 0) return Infinity;
  return k >= v.length ? -Infinity : v[k - 1];
}
function wfRow(label: string, pool: CRace[], key: (s: Score) => number, target: number) {
  const th = { P2: wfThreshold(pool, key, target, "P2"), P3: wfThreshold(pool, key, target, "P3") } as Record<Period, number>;
  const pick: Pick = (r) => {
    const p = period(r.date);
    if (p === "P1") return null;
    return key(wf(r)) >= th[p] ? wf(r).combo : null;
  };
  const tag = `${label} 目標${target}/日 (t=${th.P2.toFixed(3)}/${th.P3.toFixed(3)})`;
  row(tag, pool, pick, ["P2", "P3"]);
}
/** 日ごとにスコア上位N件（下限しきい値なし） */
function dailyTopRow(label: string, pool: CRace[], key: (s: Score) => number, nPerDay: number) {
  const byDate = new Map<string, CRace[]>();
  for (const r of pool) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r);
  const chosen = new Set<number>();
  for (const rs of byDate.values()) for (const r of [...rs].sort((a, b) => key(wf(b)) - key(wf(a))).slice(0, nPerDay)) chosen.add(r.raceId);
  row(`${label} 日次上位${nPerDay}`, pool, (r) => (chosen.has(r.raceId) ? wf(r).combo : null), ["P2", "P3"]);
}

console.log("\n==== 3. walk-forward しきい値（P以前で件/日を合わせたしきい値をPに適用）");
const keys: [string, (s: Score) => number][] = [
  ["p1", (s) => s.p1],
  ["Pw", (s) => s.pw],
  ["Pw_pure", (s) => s.pwPure],
  ["S=Pw*p1", (s) => s.s],
  ["Spure=Pwpure*p1", (s) => s.pwPure * s.p1],
];
console.log(" [現行候補内]");
for (const target of [1.5, 1.2, 1.0, 0.7]) for (const [nm, k] of keys) wfRow(`候補 ${nm}`, cand, k, target);
console.log(" [日次上位N（現行候補内）]");
for (const n of [1, 2]) for (const [nm, k] of keys) dailyTopRow(`候補 ${nm}`, cand, k, n);

// ================================================================ 4. 仮説3：母集団を広げる
const nearMiss = men.filter((r) => r.margin >= BARIKATA_MIN_MARGIN && !isBarikataCandidate(r));
const lowMargin = men.filter((r) => r.margin < BARIKATA_MIN_MARGIN);
console.log("\n==== 4. 仮説3：候補外のレース（男子、◎-モデル最上位ペア1点）");
row("候補漏れ(m>=8・非同ライン) 全部", nearMiss, modelCombo);
for (const t of [0.15, 0.18, 0.2, 0.22, 0.25]) row(`  候補漏れ S>=${t}`, nearMiss, (r) => (wf(r).s >= t ? wf(r).combo : null));
row("m<8 全部", lowMargin, modelCombo);
for (const t of [0.15, 0.18, 0.2, 0.22, 0.25]) row(`  m<8 S>=${t}`, lowMargin, (r) => (wf(r).s >= t ? wf(r).combo : null));
row("男子全R 全部", men, modelCombo);
for (const t of [0.15, 0.18, 0.2, 0.22, 0.25]) row(`  男子全R S>=${t}`, men, (r) => (wf(r).s >= t ? wf(r).combo : null));
for (const t of [0.15, 0.18, 0.2, 0.22, 0.25]) row(`  男子全R Spure>=${t}`, men, (r) => (wf(r).pwPure * wf(r).p1 >= t ? wf(r).combo : null));
console.log(" [walk-forward しきい値：男子全R・候補∪S上位]");
for (const target of [2.0, 1.5, 1.0, 0.7]) {
  wfRow("男子全R S", men, (s) => s.s, target);
  wfRow("男子全R Spure", men, (s) => s.pwPure * s.p1, target);
}
for (const n of [1, 2]) {
  dailyTopRow("男子全R S", men, (s) => s.s, n);
  dailyTopRow("男子全R Spure", men, (s) => s.pwPure * s.p1, n);
}

console.log("\n  ガールズ（1点 = ◎-本命シナリオ先頭ペア＝honmeiPool上位2）");
row("ガールズ全部", girls, modelCombo);
row("ガールズ m>=8(リーク込み)", girls, (r) => (r.margin >= 8 ? wf(r).combo : null));
row("ガールズ m>=12(リーク込み)", girls, (r) => (r.margin >= 12 ? wf(r).combo : null));
for (const t of [0.4, 0.5, 0.6, 0.7]) row(`  ガールズ Pw>=${t}`, girls, (r) => (wf(r).pw >= t ? wf(r).combo : null));
for (const target of [0.5, 0.3]) wfRow("ガールズ Pw", girls, (s) => s.pw, target);

// ================================================================ 5. 仮説4：除外条件（現行候補内のセグメント別的中率）
const lineCount = (r: CRace) => new Set(r.entries.map((e) => e.lineGroup ?? -e.car)).size;
const tankiCount = (r: CRace) => {
  const m = new Map<number, number>();
  for (const e of r.entries) if (e.lineGroup != null) m.set(e.lineGroup, (m.get(e.lineGroup) ?? 0) + 1);
  return r.entries.filter((e) => e.lineGroup == null || m.get(e.lineGroup) === 1).length;
};
const hLineSize = (r: CRace) => r.entries.filter((e) => e.lineGroup === r.entries[0].lineGroup).length;
const comboInLine = (r: CRace) => {
  const [, b, c] = wf(r).combo.split("-").map(Number);
  const lg = r.entries[0].lineGroup;
  const inL = (car: number) => r.entries.find((e) => e.car === car)?.lineGroup === lg;
  return inL(b) && inL(c) ? "2・3着とも◎ライン" : inL(b) || inL(c) ? "片方◎ライン" : "両方他ライン";
};
const segs: [string, (r: CRace) => string][] = [
  ["stage", (r) => raceStage(r.syumoku)],
  ["grade", (r) => r.grade ?? "?"],
  ["頭数", (r) => `${r.entries.length}車`],
  ["◎位置", (r) => r.entries[0].linePos ?? "?"],
  ["◎ライン人数", (r) => `${Math.min(4, hLineSize(r))}${hLineSize(r) >= 4 ? "+" : ""}`],
  ["ライン数", (r) => `${Math.min(5, lineCount(r))}`],
  ["単騎数", (r) => `${Math.min(2, tankiCount(r))}`],
  ["買い目形", comboInLine],
  ["margin帯(リーク込み)", (r) => (r.margin < 10 ? "8-10" : r.margin < 13 ? "10-13" : r.margin < 16 ? "13-16" : "16+")],
];
console.log("\n==== 5. 仮説4：現行候補のセグメント別（モデル最上位ペア1点）");
for (const [nm, f] of segs) {
  const vals = [...new Set(cand.map(f))].sort();
  console.log(` [${nm}]`);
  for (const v of vals) row(`${nm}=${v}`, cand, (r) => (f(r) === v ? wf(r).combo : null));
}
// walk-forward 除外：P以前の候補でセグメント的中率が「全体−10pt」未満かつ n>=20 のセグメントを除外してPに適用
console.log("\n  walk-forward 除外（P以前でn>=20・全体より10pt以上低いセグメントを除外）");
for (const [nm, f] of segs.filter(([n]) => !n.startsWith("margin"))) {
  const excl: Record<string, Set<string>> = {};
  for (const p of ["P2", "P3"] as Period[]) {
    const prior = cand.filter((r) => r.date < (p === "P2" ? P2_START : P3_START));
    const base = prior.filter((r) => score(r, p).combo === r.actual).length / prior.length;
    excl[p] = new Set();
    for (const v of new Set(prior.map(f))) {
      const rs = prior.filter((r) => f(r) === v);
      const h = rs.filter((r) => score(r, p).combo === r.actual).length / rs.length;
      if (rs.length >= 20 && h < base - 0.1) excl[p].add(v);
    }
  }
  row(`除外 ${nm} P2:[${[...excl.P2].join(",")}] P3:[${[...excl.P3].join(",")}]`, cand, (r) => {
    const p = period(r.date);
    if (p === "P1") return null;
    return excl[p].has(f(r)) ? null : wf(r).combo;
  }, ["P2", "P3"]);
}

// ================================================================ 6. 除外の z検定版 walk-forward と組み合わせ
// P以前の候補で「そのセグメント vs 残り」の2標本z <= -1.5（n>=20）なら除外してPに適用。
function zLow(h1: number, n1: number, h0: number, n0: number): number {
  const p = (h1 + h0) / (n1 + n0);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n0));
  return se ? (h1 / n1 - h0 / n0) / se : 0;
}
function zExclusions(pool: CRace[], f: (r: CRace) => string, p: Period): Set<string> {
  const prior = pool.filter((r) => r.date < (p === "P2" ? P2_START : P3_START));
  const hit = (r: CRace) => score(r, p).combo === r.actual;
  const out = new Set<string>();
  for (const v of new Set(prior.map(f))) {
    const a = prior.filter((r) => f(r) === v), b = prior.filter((r) => f(r) !== v);
    if (a.length >= 20 && b.length >= 20 && zLow(a.filter(hit).length, a.length, b.filter(hit).length, b.length) <= -1.5) out.add(v);
  }
  return out;
}
console.log("\n==== 6. 仮説4（z検定版 walk-forward 除外：P以前で n>=20・z<=-1.5 のセグメントを除外）");
const zEx: Record<string, Record<"P2" | "P3", Set<string>>> = {};
for (const [nm, f] of segs.filter(([n]) => !n.startsWith("margin"))) {
  zEx[nm] = { P2: zExclusions(cand, f, "P2"), P3: zExclusions(cand, f, "P3") };
  row(`z除外 ${nm} P2:[${[...zEx[nm].P2].join(",")}] P3:[${[...zEx[nm].P3].join(",")}]`, cand, (r) => {
    const p = period(r.date);
    if (p === "P1") return null;
    return zEx[nm][p].has(f(r)) ? null : wf(r).combo;
  }, ["P2", "P3"]);
}
const segF = Object.fromEntries(segs);
const zKeep = (r: CRace, names: string[]) => {
  const p = period(r.date);
  if (p === "P1") return false;
  return names.every((nm) => !zEx[nm][p].has(segF[nm](r)));
};
const zAll = segs.filter(([n]) => !n.startsWith("margin")).map(([n]) => n);
row("z除外 全セグメント同時", cand, (r) => (zKeep(r, zAll) ? wf(r).combo : null), ["P2", "P3"]);

console.log("\n  組み合わせ（固定ルール＝期間を見て選んだもの。参考）");
const lead = (r: CRace) => r.entries[0].linePos === "先頭";
const notF1 = (r: CRace) => r.grade !== "F1";
row("候補∧◎先頭", cand, (r) => (lead(r) ? wf(r).combo : null));
row("候補∧F1以外", cand, (r) => (notF1(r) ? wf(r).combo : null));
row("候補∧◎先頭∧F1以外", cand, (r) => (lead(r) && notF1(r) ? wf(r).combo : null));
const candLead = cand.filter(lead);
console.log("  walk-forward しきい値 × 部分母集団");
for (const target of [1.2, 1.0, 0.8]) {
  wfRow("候補∧◎先頭 Spure", candLead, (s) => s.pwPure * s.p1, target);
  wfRow("候補∧◎先頭 S", candLead, (s) => s.s, target);
}
for (const target of [1.2, 1.0, 0.8]) {
  // Spureのwalk-forwardしきい値に、z除外（全セグメント）を重ねる
  const key = (s: Score) => s.pwPure * s.p1;
  const th = { P2: wfThreshold(cand, key, target, "P2"), P3: wfThreshold(cand, key, target, "P3") } as Record<Period, number>;
  row(`候補 Spure 目標${target}/日 ∧ z除外全`, cand, (r) => {
    const p = period(r.date);
    if (p === "P1" || !zKeep(r, zAll)) return null;
    return key(wf(r)) >= th[p] ? wf(r).combo : null;
  }, ["P2", "P3"]);
}

// ---------------------------------------------------------------- 選ばれた側 vs 落とした側（有意性）
console.log("\n==== 7. 候補内で「選ばれた／落とした」の的中率（Spure・S 目標1.0/日、wfしきい値）");
for (const [nm, key] of [["Spure", (s: Score) => s.pwPure * s.p1], ["S", (s: Score) => s.s]] as const) {
  for (const p of ["P2", "P3"] as Period[]) {
    const th = wfThreshold(cand, key, 1.0, p);
    const rs = cand.filter((r) => period(r.date) === p);
    const sel = rs.filter((r) => key(wf(r)) >= th), rest = rs.filter((r) => key(wf(r)) < th);
    const hs = sel.filter((r) => wf(r).combo === r.actual).length, hr = rest.filter((r) => wf(r).combo === r.actual).length;
    console.log(`  ${nm} ${p}: 選択 ${hs}/${sel.length} ${pc(hs / sel.length)} vs 落選 ${hr}/${rest.length} ${pc(hr / Math.max(1, rest.length))}  z=${zLow(hs, sel.length, hr, rest.length).toFixed(2)}`);
  }
}
// P1（逆向き係数＝参考）での同じ比較
{
  const key = (s: Score) => s.pwPure * s.p1;
  const rs = cand.filter((r) => period(r.date) === "P1");
  const v = rs.map((r) => key(wf(r))).sort((a, b) => b - a);
  const th = v[Math.round(1.0 * days.P1) - 1];
  const sel = rs.filter((r) => key(wf(r)) >= th), rest = rs.filter((r) => key(wf(r)) < th);
  const hs = sel.filter((r) => wf(r).combo === r.actual).length, hr = rest.filter((r) => wf(r).combo === r.actual).length;
  console.log(`  Spure P1(参考・逆向き係数、P1内で1.0/日に合わせた): 選択 ${hs}/${sel.length} ${pc(hs / sel.length)} vs 落選 ${hr}/${rest.length} ${pc(hr / Math.max(1, rest.length))}`);
}

// ================================================================ 8. 本番移植用：全期間学習の係数としきい値
console.log("\n==== 8. 本番移植用（1着モデルpure版=全期間の男子9車除外で学習、2・3着=本番のPIT_MEN_COEFS）");
const winPureAll = fitWin(men, false, false);
console.log(`  WIN_PURE_COEFS = { ${WIN_F_MEN.slice(0, -3).map((f, i) => `${f}: ${winPureAll[i].toFixed(5)}`).join(", ")} }  (isH系は0)`);
const prodS = (r: CRace) => {
  const pe = entriesOf(r);
  const h = r.entries[0].car;
  const pw = sm(winFeatureRows(pe, h, false, false), winPureAll)[pe.findIndex((e) => e.car === h)];
  const pp = pairProbabilities(pe, h, PIT_MEN_COEFS, { girls: false });
  return { s: pw * pp[0].p, pw, p1: pp[0].p, combo: `${h}-${pp[0].second}-${pp[0].third}` };
};
const prod = cand.map((r) => ({ r, ...prodS(r) }));
const totalDays = days.P1 + days.P2 + days.P3;
const sortedS = prod.map((x) => x.s).sort((a, b) => b - a);
for (const target of [1.3, 1.0, 0.8]) {
  const th = sortedS[Math.round(target * totalDays) - 1];
  console.log(`  目標${target}/日（全期間in-sample）→ Spure >= ${th.toFixed(4)}`);
}
console.log("  固定しきい値での期間別（in-sample係数のため楽観的。件/日の目安用）");
for (const t of [0.12, 0.14, 0.15, 0.16, 0.17, 0.18, 0.2]) {
  const parts = PERIODS.map((p) => {
    const rs = prod.filter((x) => period(x.r.date) === p && x.s >= t);
    const h = rs.filter((x) => x.combo === x.r.actual).length;
    return `${p} ${h}/${rs.length} ${pc(h / Math.max(1, rs.length))} ${(rs.length / days[p]).toFixed(2)}/日`;
  });
  console.log(`  Spure>=${t}: ${parts.join(" | ")}`);
}
