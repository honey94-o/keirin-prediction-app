import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

import { getDb, closeDb } from "../lib/db";
import { raceStage } from "../lib/scoring";
import { resolveActualCombo } from "../lib/repository";
import type { ResultRow as RepoResultRow, OddsRow } from "../lib/types";

/**
 * 【検証結果: 不採用（現状維持。一様引き下げは train/test 双方で明確に悪化、
 * 唯一「筋が良さそうに見えた」二分戦だけの引き下げも、全体では小幅なプラスに
 * 見える一方でtrain/testが逆方向に動き、追加分単体もtrain172.8%・test63.5%と
 * 振れ幅が大きすぎて再現性を主張できるサンプルではなかった）】
 *
 * scripts/diagnose-line-count.ts（分戦数は交絡なしの本物の信号だが、三分戦+の
 * 閾値を上げると勝率はそのままROIだけ悪化する＝三分戦+の高margin帯はむしろ
 * 良質なvalue）と、lib/repository.tsのgetDailyPicksのコメントに残る一次検証
 * （margin>=0|top10は106日で回収率87.4%、margin>=10|top10は91.3%）の2つを
 * 踏まえ、「margin>=10という閾値は保守的すぎて、1日平均3.5件しか出ない厳選を
 * 不必要に絞っているのでは」という次の疑問を検証する。
 *
 * 対象データ・除外基準はdiagnose-line-count.ts / diagnose-interview-exclusion.ts
 * と同一: predictions×racesをtotal_score降順で1位=◎・2位=○として復元し、
 * entries.line_groupから分戦数を算出。encp LIKE 'wt:%'（並び予想が確実に入って
 * いるレースのみ、分戦数算出の信頼性を担保するため）に限定。厳選候補としての
 * 除外基準はcompute-picks.tsのdailyPicks構築と同じ（予選除外・9人立て除外・
 * 本命formation必須）。的中判定はresolveActualCombo（lib/repository.ts）による
 * 3連単フォーメーション的中（1点100円換算）。train/test分割はkaisai_date昇順で
 * 2/3・1/3（このプロジェクトの標準、分割日20260724）。
 * 母集団: predictions保存済み(wt:)のうち予選除外3249・9人立て除外595を引いた
 * 8,219件（本命formation無し・line_group無しの除外は0件）。
 *
 * ■ Step1: margin帯別・分戦数別の成績（現行10未満の帯を新設、10以上は参考、
 *   すべて実際の3連単フォーメーション的中・ROIベース。上位10件/日キャップは
 *   このStep1の集計には適用していない＝母集団の帯別成績そのもの）
 *
 *   全体:
 *     margin6-8  : 的中31.0%(245/791) 回収率117.6%(train31.3%(162/518)/107.6% test30.4%(83/273)/136.6%)
 *     margin8-9  : 的中31.7%(88/278)  回収率98.3% (train32.0%(55/172)/71.5%  test31.1%(33/106)/141.9%)
 *     margin9-10 : 的中38.8%(76/196)  回収率103.7%(train40.6%(52/128)/117.6% test35.3%(24/68)/77.6%)
 *     margin10-12: 的中57.0%(142/249) 回収率141.1%(train58.7%(101/172)/136.5% test53.2%(41/77)/156.9%)
 *     margin12-15: 的中51.1%(97/190)  回収率89.5% (train61.3%(76/124)/100.0% test31.8%(21/66)/54.2%)
 *     margin15+  : 的中65.5%(78/119)  回収率86.1% (train63.4%(45/71)/77.3%  test68.8%(33/48)/107.0%)
 *   → 8-9・9-10帯はROIが100%前後で拮抗、6-8帯は的中率が低い割にROI117.6%と
 *   意外に高い（train107.6%/test136.6%とtestに偏っており過学習の疑いあり）。
 *   さらに12-15帯がROI89.5%（test54.2%まで沈む）と、隣接する10-12帯(141.1%)・
 *   15+帯(86.1%)の間で不自然に凹んでおり、margin→ROIの関係はこの母数
 *   （帯あたりn=119〜278）では単調でもなだらかでもなく、ノイズが大きいことが
 *   わかる。「10という閾値の周辺に特異点がある」という証拠もなければ、
 *   「なだらかに単調」という単純な仮説も高margin側では崩れる。
 *
 *   二分戦:
 *     margin6-8  : 的中30.8%(90/292) 回収率87.7% (train30.1%(55/183)/85.3% test32.1%(35/109)/91.6%)
 *     margin8-9  : 的中28.1%(25/89)  回収率38.9% (train26.9%(14/52)/24.4% test29.7%(11/37)/59.3%)
 *     margin9-10 : 的中36.4%(20/55)  回収率129.1%(train36.4%(12/33)/172.8% test36.4%(8/22)/63.5%)
 *     margin10-12: 的中55.6%(35/63)  回収率65.8% (train54.3%(25/46)/76.0% test58.8%(10/17)/24.1%)
 *     margin12-15: 的中61.7%(29/47)  回収率117.4%(train73.3%(22/30)/138.9% test41.2%(7/17)/38.9%)
 *   三分戦+:
 *     margin6-8  : 的中22.6%(77/341) 回収率124.6%(train24.7%(57/231)/99.6% test18.2%(20/110)/177.1%)
 *     margin8-9  : 的中23.3%(27/116) 回収率140.5%(train23.6%(17/72)/75.9% test22.7%(10/44)/246.3%)
 *     margin9-10 : 的中29.9%(23/77)  回収率101.0%(train31.3%(15/48)/97.4% test27.6%(8/29)/106.8%)
 *     margin10-12: 的中56.0%(56/100) 回収率199.2%(train57.5%(42/73)/175.4% test51.9%(14/27)/291.7%)
 *   → margin9-10帯だけを見ると二分戦ROI129.1%・三分戦+ROI101.0%で、二分戦を
 *   先に下げる方が筋が良さそうに見える。ただし二分戦9-10帯はn=55（train33/
 *   test22）と薄く、train172.8%・test63.5%と方向すら怪しい。10-12帯では逆に
 *   二分戦ROI65.8%・三分戦+ROI199.2%（diagnose-line-count.tsが既に発見した
 *   「三分戦+は勝率低いが配当高い」パターンそのもの）と、二分戦の方が明確に
 *   劣る帯もある。分戦数別の帯別ROIはこの母数では一貫した傾向として使うには
 *   ノイズが大きすぎる。
 *
 * ■ Step2: 実際の厳選（top10/日、160日）選定シミュレーション
 *   上位10件キャップの発動確認: margin>=6で90/160日・>=7で47/160日・>=8で
 *   19/160日・>=9で6/160日が「候補>10件」となり、閾値を下げるほどキャップが
 *   効き始める（>=10では0/160日=キャップは無風、というdiagnose-line-count.ts
 *   の確認と一致）。よって候補(a)(b)はキャップの影響を含めたシミュレーション
 *   値である点に注意。
 *
 *   baseline（現行）margin>=10: 1日平均3.49件(558件/160日)
 *     全体 的中56.8%(317/558) 回収率114.7% | train60.5%(222/367)/114.9% | test49.7%(95/191)/113.9%
 *
 *   候補(a) 一様引き下げ margin>=9: 1日平均4.66件(745件、+33.5%)
 *     全体 的中52.2%(389/745) 回収率112.8% | train55.4%(273/493)/114.7% | test46.0%(116/252)/107.1%
 *     → train横ばい・testで-6.8pt。一様引き下げは体積増を買うためにtest ROIを
 *     犠牲にする形。
 *
 *   候補(b) 一様引き下げ margin>=8: 1日平均6.16件(986件、+76.7%)
 *     全体 的中47.0%(463/986) 回収率108.2% | train49.6%(320/645)/109.6% | test41.9%(143/341)/104.5%
 *     → train/testともbaseline比で明確に悪化（-5.3pt/-9.4pt）。一様引き下げは
 *     8・9いずれの水準でも不採用が明確。
 *
 *   候補(c) 分戦数で非対称: 二分戦margin>=9 / 三分戦+margin>=10のまま:
 *     1日平均3.83件(612件、+9.7%)
 *     全体 的中54.9%(336/612) 回収率115.2% | train58.5%(234/400)/117.0% | test48.1%(102/212)/109.6%
 *     → 全体ROIはbaseline比+0.5pt(114.7→115.2)と一見改善だが、train(+2.1pt)は
 *     上がりtest(-4.3pt)は下がっており方向が逆。このプロジェクトの採用基準
 *     （train/testが同方向に動くこと）を満たさない。
 *
 *   候補(d) 分戦数で非対称: 二分戦margin>=8 / 三分戦+margin>=10のまま:
 *     1日平均4.37件(699件、+25.3%)
 *     全体 的中51.5%(360/699) 回収率109.8% | train54.9%(248/452)/112.0% | test45.3%(112/247)/103.2%
 *     → train/testとも(c)よりさらに悪化。二分戦だけでも8まで下げるとtrain/test
 *     双方でbaseline割れ。
 *
 *   候補(e)（逆方向・念のため）二分戦margin>=10のまま / 三分戦+margin>=9:
 *     1日平均4.34件(695件、+24.6%)
 *     全体 的中53.4%(371/695) 回収率112.5% | train56.8%(262/461)/113.4% | test46.6%(109/234)/109.7%
 *     → train/testとも悪化方向で一致（狙い通りの逆効果）。分戦数の非対称性は
 *     「三分戦+側を下げるのは損」というdiagnose-line-count.tsの結論と整合する。
 *
 * ■ 追加分単体の成績（baselineに新規追加される候補だけを取り出した決定的な数字）
 *   候補(a)追加分=全体margin9-10(n=196): 的中38.8%(76/196) 回収率103.7%
 *     (train40.6%(52/128)/117.6% test35.3%(24/68)/77.6%) → trainは黒字、testは
 *     赤字転落で方向不一致。
 *   候補(b)追加分=全体margin8-10(n=474): 的中34.6%(164/474) 回収率100.5%
 *     (train35.7%(107/300)/91.1% test32.8%(57/174)/116.8%) → ほぼ収支均衡だが
 *     ここでもtrain赤字・test黒字と方向がねじれている。
 *   候補(c)追加分=二分戦margin9-10(n=55): 的中36.4%(20/55) 回収率129.1%
 *     (train36.4%(12/33)/172.8% test36.4%(8/22)/63.5%) → 全体では黒字に見えるが
 *     train172.8%とtest63.5%の差が大きすぎ、しかもtrain33件・test22件と
 *     このプロジェクトの目安（診断あたり最低30件程度）を下回る薄さ。数件の
 *     高配当的中でtrain側の数字が持ち上がっているだけの可能性が高い。
 *   候補(d)追加分=二分戦margin8-10(n=144): 的中31.3%(45/144) 回収率73.3%
 *     (train30.6%(26/85)/82.0% test32.2%(19/59)/60.8%) → train/testとも
 *     明確な赤字。候補(c)からさらに下げると追加分自体が損失に転じる。
 *   候補(e)追加分=三分戦+margin9-10(n=77): 的中29.9%(23/77) 回収率101.0%
 *     (train31.3%(15/48)/97.4% test27.6%(8/29)/106.8%) → ほぼ収支均衡、
 *     明確な儲けにはならない。
 *
 * ■ 結論: 不採用（現状のmargin>=10を維持）
 *   一様引き下げ（候補a・b）はtrain/testとも一貫して悪化するため明確に不採用。
 *   分戦数による非対称引き下げ（候補c: 二分戦だけmargin>=9）は、全体で見ると
 *   ROIがbaseline並み（むしろ+0.5pt）に見え、diagnose-line-count.tsの
 *   「二分戦の方が勝率が高い」という知見とも方向は整合するため一見有望に映るが、
 *   (1) train/testでROIの動く方向が逆（train改善・test悪化）、(2) 判断の核である
 *   追加分単体もtrain172.8%対test63.5%と裏付けにならないほど振れており、
 *   (3) その追加分の絶対件数もtrain33・test22件と、このプロジェクトが他の
 *   診断（diagnose-interview-exclusion.ts等）で判断不能の目安としてきた水準に
 *   近い薄さ、という3点がすべて「まだ言い切れない」方向を向いている。
 *   1日あたりの体積インパクトも+0.34件（3.49→3.83、+9.7%）に留まり、月100k円
 *   目標に効くほどの規模でもない。以上より、lib/repository.ts・
 *   scripts/compute-picks.ts・lib/scoring.tsへの変更は一切行わず、
 *   DAILY_PICKS_MIN_MARGIN=10を維持する（現状維持）。今回の副産物として、
 *   margin6-15の間のROIが必ずしも単調でない（12-15帯が10-12帯・15+帯に挟まれて
 *   凹む）ことも確認できたが、これも帯あたりn=119〜278程度のノイズの範囲内と
 *   見るべきで、閾値変更を正当化する根拠にはならない。
 */

type PredRow = {
  race_id: number;
  kaisai_date: string;
  syumoku: string | null;
  car_num: number;
  snum: string;
  total_score: number;
  formation: string | null;
};
type EntryRow = { race_id: number; car_num: number; snum: string; line_group: number | null };
type ResultRow = { race_id: number; car_num: number; finish_pos: number };
type OddsDbRow = { race_id: number; bet_type: string; combination: string; odds_value: number | null };

type Candidate = {
  raceId: number;
  date: string;
  margin: number;
  lineCount: number;
  formation: string[];
  actualCombo: string | null;
  hitOdds: number | null;
};

type SelResult = { hits: number; races: number; stake: number; payout: number };

function evalOutcomes(arr: Candidate[]): SelResult {
  let hits = 0,
    races = 0,
    stake = 0,
    payout = 0;
  for (const c of arr) {
    if (c.actualCombo == null) continue;
    races++;
    stake += 100 * c.formation.length;
    if (c.formation.includes(c.actualCombo)) {
      hits++;
      if (c.hitOdds != null) payout += 100 * c.hitOdds;
    }
  }
  return { hits, races, stake, payout };
}

function fmtSel(s: SelResult): string {
  const hr = s.races > 0 ? ((100 * s.hits) / s.races).toFixed(1) + "%" : "-";
  const roi = s.stake > 0 ? ((100 * s.payout) / s.stake).toFixed(1) + "%" : "-";
  return `的中${hr}(${s.hits}/${s.races}) 回収率${roi}`;
}

async function main() {
  const db = getDb();

  console.log("========== データ取得（encp LIKE 'wt:%' のみ、分戦数算出の信頼性確保） ==========");

  const [predRes, entRes, resRes, oddsRes] = await Promise.all([
    db.execute(`
      SELECT p.race_id, ra.kaisai_date, ra.syumoku, p.car_num, p.snum, p.total_score, p.formation
      FROM predictions p
      JOIN races ra ON ra.id = p.race_id
      WHERE ra.encp LIKE 'wt:%'
      ORDER BY p.race_id, p.total_score DESC
    `),
    db.execute(`
      SELECT e.race_id, e.car_num, e.snum, e.line_group
      FROM entries e
      JOIN races ra ON ra.id = e.race_id
      WHERE ra.encp LIKE 'wt:%'
    `),
    db.execute(`
      SELECT res.race_id, res.car_num, res.finish_pos
      FROM results res
      JOIN races ra ON ra.id = res.race_id
      WHERE ra.encp LIKE 'wt:%' AND res.finish_pos IS NOT NULL
    `),
    db.execute(`
      SELECT o.race_id, o.bet_type, o.combination, o.odds_value
      FROM odds o
      JOIN races ra ON ra.id = o.race_id
      WHERE ra.encp LIKE 'wt:%' AND o.bet_type = '3連単'
    `),
  ]);

  const predRows = predRes.rows as unknown as PredRow[];
  const entRows = entRes.rows as unknown as EntryRow[];
  const resRows = resRes.rows as unknown as ResultRow[];
  const oddsRows = oddsRes.rows as unknown as OddsDbRow[];

  console.log(
    `predictions行数: ${predRows.length} / entries行数: ${entRows.length} / ` +
      `results行数: ${resRows.length} / odds(3連単)行数: ${oddsRows.length}`
  );

  const entriesByRace = new Map<number, EntryRow[]>();
  for (const e of entRows) {
    const arr = entriesByRace.get(e.race_id) ?? [];
    arr.push(e);
    entriesByRace.set(e.race_id, arr);
  }

  const predByRace = new Map<number, PredRow[]>();
  for (const p of predRows) {
    const arr = predByRace.get(p.race_id) ?? [];
    arr.push(p);
    predByRace.set(p.race_id, arr);
  }

  const resultsByRace = new Map<number, RepoResultRow[]>();
  for (const r of resRows) {
    const arr = resultsByRace.get(r.race_id) ?? [];
    arr.push({ car_num: r.car_num, snum: "", finish_pos: r.finish_pos, kimarite: null });
    resultsByRace.set(r.race_id, arr);
  }
  const oddsByRace = new Map<number, OddsRow[]>();
  for (const o of oddsRows) {
    const arr = oddsByRace.get(o.race_id) ?? [];
    arr.push({ bet_type: o.bet_type, combination: o.combination, odds_value: o.odds_value, ninki: null });
    oddsByRace.set(o.race_id, arr);
  }

  function lineCountOf(raceId: number): number | null {
    const members = entriesByRace.get(raceId);
    if (!members || members.length === 0) return null;
    const sizeByGroup = new Map<number, number>();
    for (const m of members) {
      if (m.line_group == null) continue;
      sizeByGroup.set(m.line_group, (sizeByGroup.get(m.line_group) ?? 0) + 1);
    }
    return [...sizeByGroup.values()].filter((size) => size >= 2).length;
  }

  // ---- compute-picks.tsのdailyPicks構築と同じ除外基準で候補を作る ----
  const candidates: Candidate[] = [];
  let excludedYosen = 0;
  let excluded9car = 0;
  let excludedNoFormation = 0;
  let excludedNoLineData = 0;

  for (const [raceId, preds] of predByRace) {
    const sorted = [...preds].sort((a, b) => b.total_score - a.total_score);
    if (sorted.length < 2) continue;
    if (raceStage(sorted[0].syumoku) === "予選") {
      excludedYosen++;
      continue;
    }
    const fieldSize = entriesByRace.get(raceId)?.length ?? 0;
    if (fieldSize === 9) {
      excluded9car++;
      continue;
    }
    const honmei = sorted[0];
    const taikou = sorted[1];
    if (!honmei.formation) {
      excludedNoFormation++;
      continue;
    }
    const lineCount = lineCountOf(raceId);
    if (lineCount == null) {
      excludedNoLineData++;
      continue;
    }

    const results = resultsByRace.get(raceId) ?? [];
    const odds = oddsByRace.get(raceId) ?? [];
    const actualCombo = resolveActualCombo(results, odds);
    const hitOdds =
      actualCombo != null
        ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null)
        : null;

    candidates.push({
      raceId,
      date: honmei.kaisai_date,
      margin: honmei.total_score - taikou.total_score,
      lineCount,
      formation: JSON.parse(honmei.formation) as string[],
      actualCombo,
      hitOdds,
    });
  }

  console.log(
    `厳選候補: ${candidates.length}件（予選除外${excludedYosen} / 9人立て除外${excluded9car} / ` +
      `本命formation無し除外${excludedNoFormation} / line_group無し除外${excludedNoLineData}）`
  );

  const dates = [...new Set(candidates.map((c) => c.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`train/test分割日: ${split}（train: <${split}, test: >=${split}）`);

  const twoLine = candidates.filter((c) => c.lineCount === 2);
  const threePlus = candidates.filter((c) => c.lineCount >= 3);

  function bandStats(arr: Candidate[], split: string): string {
    const train = arr.filter((c) => c.date < split);
    const test = arr.filter((c) => c.date >= split);
    return `${fmtSel(evalOutcomes(arr))} (train${fmtSel(evalOutcomes(train))} / test${fmtSel(evalOutcomes(test))})`;
  }

  console.log(
    "\n========== Step1: margin帯別・分戦数別の成績（現行閾値10未満の帯を新設） =========="
  );
  const marginBands: [string, (m: number) => boolean][] = [
    ["6-8", (m) => m >= 6 && m < 8],
    ["8-9", (m) => m >= 8 && m < 9],
    ["9-10", (m) => m >= 9 && m < 10],
    ["10-12", (m) => m >= 10 && m < 12],
    ["12-15", (m) => m >= 12 && m < 15],
    ["15+", (m) => m >= 15],
  ];
  console.log("  --- 全体 ---");
  for (const [label, pred] of marginBands) {
    console.log(`  margin${label}: ${bandStats(candidates.filter((c) => pred(c.margin)), split)}`);
  }
  console.log("  --- 二分戦 ---");
  for (const [label, pred] of marginBands) {
    console.log(`  margin${label}: ${bandStats(twoLine.filter((c) => pred(c.margin)), split)}`);
  }
  console.log("  --- 三分戦+ ---");
  for (const [label, pred] of marginBands) {
    console.log(`  margin${label}: ${bandStats(threePlus.filter((c) => pred(c.margin)), split)}`);
  }

  // ---- Step2: 実際の厳選（top10/日）選定シミュレーション ----
  console.log("\n========== Step2: 厳選(daily_picks) top10/日 選定シミュレーション ==========");

  const byDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byDate.get(c.date) ?? [];
    arr.push(c);
    byDate.set(c.date, arr);
  }
  const numDays = byDate.size;
  console.log(`対象日数: ${numDays}日`);

  function simulate(eligibleFn: (c: Candidate) => boolean, dateFilter: (d: string) => boolean): SelResult & { days: number; picks: number } {
    let hits = 0,
      races = 0,
      stake = 0,
      payout = 0,
      picks = 0,
      days = 0;
    for (const [date, arr] of byDate) {
      if (!dateFilter(date)) continue;
      days++;
      const top10 = arr.filter(eligibleFn).sort((a, b) => b.margin - a.margin).slice(0, 10);
      picks += top10.length;
      for (const c of top10) {
        if (c.actualCombo == null) continue;
        races++;
        stake += 100 * c.formation.length;
        if (c.formation.includes(c.actualCombo)) {
          hits++;
          if (c.hitOdds != null) payout += 100 * c.hitOdds;
        }
      }
    }
    return { hits, races, stake, payout, days, picks };
  }

  const isAll = () => true;
  const isTrain = (d: string) => d < split;
  const isTest = (d: string) => d >= split;

  function reportCandidateRule(label: string, eligibleFn: (c: Candidate) => boolean): void {
    const all = simulate(eligibleFn, isAll);
    const train = simulate(eligibleFn, isTrain);
    const test = simulate(eligibleFn, isTest);
    console.log(`\n--- ${label} ---`);
    console.log(`  1日平均ピック数: ${(all.picks / all.days).toFixed(2)}件（${all.days}日で${all.picks}件）`);
    console.log(`  全体 ${fmtSel(all)}`);
    console.log(`  train ${fmtSel(train)}`);
    console.log(`  test  ${fmtSel(test)}`);
  }

  // 「上位10件」キャップの発動確認（閾値を下げるほど候補が増えるため念のため）
  for (const th of [6, 7, 8, 9, 10]) {
    let daysOver10 = 0;
    for (const [, arr] of byDate) {
      if (arr.filter((c) => c.margin >= th).length > 10) daysOver10++;
    }
    console.log(`margin>=${th}で1日10件を超えた日数: ${daysOver10}/${numDays}日`);
  }

  reportCandidateRule("baseline（現行）: margin>=10", (c) => c.margin >= 10);
  reportCandidateRule("候補(a) 一様引き下げ: margin>=9", (c) => c.margin >= 9);
  reportCandidateRule("候補(b) 一様引き下げ: margin>=8", (c) => c.margin >= 8);
  reportCandidateRule(
    "候補(c) 分戦数で非対称: 二分戦margin>=9 / 三分戦+margin>=10",
    (c) => (c.lineCount === 2 ? c.margin >= 9 : c.margin >= 10)
  );
  reportCandidateRule(
    "候補(d) 分戦数で非対称: 二分戦margin>=8 / 三分戦+margin>=10",
    (c) => (c.lineCount === 2 ? c.margin >= 8 : c.margin >= 10)
  );
  reportCandidateRule(
    "候補(e) 逆方向（念のため）: 二分戦margin>=10 / 三分戦+margin>=9",
    (c) => (c.lineCount === 2 ? c.margin >= 10 : c.margin >= 9)
  );

  // ---- 追加分（新たに拾われるようになった候補）単体の成績 = 決定的な数字 ----
  console.log("\n========== 追加分単体の成績（baseline比、これが儲かっているかが判断の核） ==========");

  function marginalStats(label: string, isMarginal: (c: Candidate) => boolean): void {
    const marginal = candidates.filter(isMarginal);
    console.log(`  ${label} (n=${marginal.length}): ${bandStats(marginal, split)}`);
  }

  marginalStats("候補(a)追加分 = 全体margin9-10", (c) => c.margin >= 9 && c.margin < 10);
  marginalStats("候補(b)追加分 = 全体margin8-10", (c) => c.margin >= 8 && c.margin < 10);
  marginalStats("候補(c)追加分 = 二分戦margin9-10", (c) => c.lineCount === 2 && c.margin >= 9 && c.margin < 10);
  marginalStats("候補(d)追加分 = 二分戦margin8-10", (c) => c.lineCount === 2 && c.margin >= 8 && c.margin < 10);
  marginalStats("候補(e)追加分 = 三分戦+margin9-10", (c) => c.lineCount >= 3 && c.margin >= 9 && c.margin < 10);

  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
