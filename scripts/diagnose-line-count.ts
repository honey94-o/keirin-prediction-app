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
 * 【検証結果: 不採用（相関自体は交絡なしの本物だが、厳選の実際の選定メカニズムでは
 * 実行不能／逆効果と判明）】
 *
 * 「分戦数」（レース内で実在する複数人ライン＝line_group人数2以上のグループの
 * 個数。1=先行1車、2=二分戦、3=三分戦、4=四分戦、0=全員単騎）別の本命(◎)勝率が
 * きれいな単調減少（52.7%→45.0%→38.3%→31.3%、二分戦と三分戦以上で7〜8pt差）を
 * 示すという一次発見の交絡チェックと、実際の厳選(daily_picks)選定への適用可否を検証する。
 *
 * predictions テーブル（total_score降順で1位=◎相当・2位=○相当を復元する方式。
 * scripts/diagnose-interview-exclusion.tsと同じ理由・同じ手法：predictRaceを毎回
 * 再実行せず発走前スナップショットを使う）と、entries.line_groupから算出した
 * 分戦数を突き合わせる。対象はencp LIKE 'wt:%'（並び予想が確実に入っている）
 * レースのみ（12,063レース、本命finish不明132件を除いた11,931件で分析、
 * train/test分割日20260724）。
 *
 * ■ Step1: 中心仮説の再現確認
 *   分戦数0(全員単騎): 66.6%(n=1196)　1(先行1車): 52.7%(n=275、train51.0/test56.6)
 *   分戦数2(二分戦)  : 45.0%(n=4259, train45.4/test44.4)
 *   分戦数3(三分戦)  : 38.3%(n=5766, train38.0/test38.9)
 *   分戦数4(四分戦)  : 31.3%(n=435,  train33.9/test25.4)
 *   分戦数3+合算    : 37.8%(n=6201, train37.7/test38.1)
 *   → ユーザー提示の一次発見と一致。単調減少・train/testとも安定。
 *
 * ■ Step2【決定的】: marginで層別（二分戦 vs 三分戦+）
 *   margin<5  : 二分戦37.8%(train38.1/test37.3,n=3073) vs 三分戦+32.0%(train32.2/
 *     test31.6,n=4546) → 差5.8pt、train/testとも安定
 *   margin5-10: 二分戦58.6%(train58.5/test58.9,n=918)  vs 三分戦+48.4%(train47.3/
 *     test50.7,n=1295) → 差10.2pt、train/testとも安定（このプロジェクトで見た
 *     margin層別の中でも最大級の残存幅）
 *   margin10-15: 二分戦78.8%(train79.7/test76.6,n=217) vs 三分戦+70.1%(train69.2/
 *     test71.9,n=291) → 差8.7pt、train/testとも安定
 *   margin15+ : 二分戦90.2%(train89.3/test91.3,n=51)   vs 三分戦+87.0%(train80.5/
 *     test96.4,n=69) → 差3.2pt。testだけ逆転(91.3<96.4)だが母数n=23/28と薄く、
 *     二項ノイズの範囲内。
 *   → 全4帯でtrain側は一貫して二分戦が上回り、testも3/4帯で同方向。marginで
 *   説明しきれない独立した情報であり、単なるmarginの言い換え（交絡）ではないと判断。
 *   class_rank×marginの二重層別（Step3c）でもほぼ全セルで同方向を再確認した。
 *
 * ■ Step3a: class_rank(本命)で層別
 *   A1以上(SS/S1/S2/A1): 二分戦41.1%(train41.1/test41.1,n=2232) vs 三分戦+35.1%
 *     (train35.2/test34.9,n=4434) → 差6.0pt、train/testとも完全に安定
 *   A2以下(A2/A3)      : 二分戦49.3%(train50.1/test47.8,n=2019) vs 三分戦+44.1%
 *     (train44.0/test44.3,n=1747) → 差5.2pt、安定
 *   級班別（S1以下は母数十分）でもS1〜A2は二分戦が上回り、A3のみ僅差(47.6 vs
 *   46.6)。SSはn=2と極小で参考外。
 *   → class_rankで統制しても消えない。
 *
 * ■ Step3b: heikin_tokuten(フィールド平均)三分位で層別
 *   低位帯: 二分戦51.5%(train51.7/test51.0,n=1657) vs 三分戦+48.8%(train50.2/
 *     test46.6,n=1042) → 差2.7pt
 *   中位帯: 二分戦45.2%(train45.8/test44.2,n=1602) vs 三分戦+39.1%(train38.7/
 *     test39.9,n=2244) → 差6.1pt、安定
 *   高位帯: 二分戦34.1%(train33.4/test35.2,n=1000) vs 三分戦+32.9%(train32.6/
 *     test33.3,n=2915) → 差1.2pt、ほぼ誤差範囲まで縮小
 *   → 低・中位帯では明確に残るが、フィールド全体のレベルが高い（強い選手が
 *   揃う）レースでは分戦数の効果がほぼ消える。全体としては交絡ではないが、
 *   高レベル帯では実質ノイズという境界条件がある。
 *
 * ■ 総合判断（Step1-3、単体の予測情報としての評価）
 *   margin・class_rank・heikin_tokutenいずれで統制してもtrain/testとも同方向で
 *   概ね残存し、このプロジェクトのこれまでの「相関はあるが交絡/過学習」パターン
 *   （diagnose-nige-senko-bantesu.ts等）とは一線を画す、独立した本物の情報と判断した。
 *   ここまでは一次発見の主張通り「今日見つかった中で最も強くクリーンな信号」。
 *
 * ■ Step4: 厳選(daily_picks)top10選定への適用シミュレーション
 * compute-picks.tsのdailyPicks構築と同じ除外基準（予選除外・9人立て除外・本命
 * formation必須）で候補8,219件を作り、日別にgetDailyPicksと同じ「margin>=10を
 * 満たすものを margin降順で上位10件」を再現。案(a)ランキング変更・案(c)閾値変更
 * の両方を試した。
 *
 *  前提の確認: margin>=10を満たすレースは160日間で全558件（1日平均3.5件）、
 *  「1日で10件を超えた日」は0日。→ 厳選の「上位10件」キャップは、この母集団では
 *  事実上一度も効いていない。
 *
 *  案(a) 参考（ランキング順のみを分戦数調整後marginに変更、二分戦+5/三分戦+-5、
 *  閾値はmargin>=10のまま）:
 *    全体 的中56.8%(317/558) 回収率114.7% ＝ 現行と完全に同一
 *  → 上記の通りキャップが一度も効いていないため、並び替えだけでは選定結果自体が
 *  1件も変わらない。案(a)はこの運用形態では原理的に無意味。
 *
 *  案(c)（三分戦+のみ閾値を引き上げ、二分戦はmargin>=10のまま。実際に候補を除外する）:
 *    旧基準(全員margin>=10)        : 全体56.8%(317/558) 回収率114.7%
 *      train60.5%(222/367)回収率114.9% / test49.7%(95/191)回収率113.9%
 *    三分戦+のみmargin>=12: 全体57.0%(261/458)回収率86.2%
 *      train61.2%(180/294)回収率93.3% / test49.4%(81/164)回収率65.0%
 *    三分戦+のみmargin>=13: 全体59.0%(250/424)回収率89.4%
 *      train63.3%(171/270)回収率96.7% / test51.3%(79/154)回収率67.7%
 *    三分戦+のみmargin>=15: 全体58.8%(234/398)回収率88.7%
 *      train62.3%(157/252)回収率97.8% / test52.7%(77/146)回収率63.6%
 *    三分戦+のみmargin>=18: 全体58.1%(216/372)回収率88.6%
 *      train62.0%(145/234)回収率101.7% / test51.4%(71/138)回収率53.4%
 *  → 的中率は横ばい〜微増（56.8%→57-59%）なのに、回収率はどの引き上げ幅でも
 *  114.7%→86-89%へ一貫して悪化し、train/testとも同方向（改善する帯が無い）。
 *
 *  悪化の理由（内訳確認）: raise=2で除外される「三分戦+・margin10-12」レース
 *  単体（n=100）の実績は 的中56.0%・回収率199.2% と、除外前の全体平均(56.8%/
 *  114.7%)と的中率はほぼ同じなのに回収率は約1.7倍。つまりこの帯の三分戦+レースは
 *  「本命が勝つ確率はやや低いが、勝った時の配当は高い」——分戦数が多い＝競合が
 *  多いレースほど市場（オッズ）も本命を過信していない分、的中時の払戻が大きい。
 *  Step1-3で確認した「三分戦+は本命の勝率が低い」という事実それ自体は正しいが、
 *  厳選が実際に最適化しているのは勝率ではなく複勝式点数×オッズの期待値（ROI）
 *  であり、その軸で見ると三分戦+の高margin帯はむしろ相対的に good value（勝率の
 *  低さをオッズの高さが上回る）だった。案(c)はこの高配当帯を勝率の低さだけを
 *  理由に切り捨ててしまうため、的中率はほぼ変えずに回収率だけを毀損する。
 *
 * ■ 総合判断（実装可否）
 *   Step1-3の相関自体はこのプロジェクトの基準（margin・class_rank・heikin_tokuten
 *   での層別、train/testクロノロジカル分割）に照らして交絡・過学習のいずれでもない
 *   独立した本物の情報だが、Step4で「厳選」の実際の選定メカニズムに当てはめると
 *   (1) 現状の運用（1日平均3.5件、10件キャップが事実上不発動）ではランキング変更
 *   （案a）は選定結果を一切変えない無意味な変更であり、(2) 実際に選定を変える
 *   唯一の手段である閾値変更（案c）は、勝率とROIの目的関数の違いにより明確に
 *   逆効果（回収率114.7%→86-89%、train/testとも悪化）と判明した。
 *   案(b)（lib/scoring.tsのスコアリング自体に折り込み、backtest.ts --limit=3000
 *   で前後比較）は実施していない：案(b)も内部的には「三分戦+の本命のtotal_score
 *   を下げてmarginを圧縮する」のと機構的に同じであり、案(c)で確認した「勝率は
 *   ほぼ変えずに高配当帯を狙い撃ちで除外し回収率だけ悪化させる」という力学が
 *   そのまま働くと考えられる。35-40分かかるbacktest.tsのフルランを費やす前に、
 *   案(c)の結果で実装方向自体が誤りだと判断できたため、確認目的の実行は行わなかった。
 *   以上より、lib/scoring.ts・scripts/compute-picks.ts・lib/repository.tsへの
 *   変更は一切行わない（現状維持）。「勝率で見て強い相関＝的中率ベースの厳選に
 *   有効」とは限らず、複勝式のROI最適化では「当たりにくいが当たれば大きい」逆側の
 *   情報として働きうる、という今回特有の教訓を得た。
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
type RacerRow = { snum: string; class_rank: string | null; heikin_tokuten: number | null };
type OddsDbRow = { race_id: number; bet_type: string; combination: string; odds_value: number | null };

type Rec = {
  raceId: number;
  date: string;
  win: boolean;
  margin: number;
  lineCount: number;
  honmeiClassRank: string | null;
  honmeiTokuten: number | null;
  fieldAvgTokuten: number | null;
};

function rate(arr: { win: boolean }[]): string {
  return arr.length
    ? ((100 * arr.filter((r) => r.win).length) / arr.length).toFixed(1) + "%(n=" + arr.length + ")"
    : "-(n=0)";
}

function rateTT(arr: { win: boolean; date: string }[], split: string): string {
  const train = arr.filter((r) => r.date < split);
  const test = arr.filter((r) => r.date >= split);
  return `全体${rate(arr)} train${rate(train)} test${rate(test)}`;
}

async function main() {
  const db = getDb();

  console.log("========== データ取得 ==========");

  const [predRes, entRes, resRes, racerRes, oddsRes] = await Promise.all([
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
    db.execute(`SELECT snum, class_rank, heikin_tokuten FROM racers`),
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
  const racerRows = racerRes.rows as unknown as RacerRow[];
  const oddsRows = oddsRes.rows as unknown as OddsDbRow[];

  console.log(`predictions行数: ${predRows.length} / entries行数: ${entRows.length} / results行数: ${resRows.length} / odds(3連単)行数: ${oddsRows.length}`);

  const racerMap = new Map<string, RacerRow>();
  for (const r of racerRows) racerMap.set(r.snum, r);

  const finishMap = new Map<string, number>();
  for (const r of resRows) finishMap.set(`${r.race_id}:${r.car_num}`, r.finish_pos);

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

  // resolveActualCombo（lib/repository.ts）が受け取る形（ResultRow[]/OddsRow[]）に
  // race_idごとへ組み直す。
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

  const records: Rec[] = [];
  let totalRaces = 0;
  let skippedNoScoredPair = 0;
  let skippedNoFinish = 0;
  let skippedNoLineData = 0;

  for (const [raceId, preds] of predByRace) {
    totalRaces++;
    const sorted = [...preds].sort((a, b) => b.total_score - a.total_score);
    if (sorted.length < 2) {
      skippedNoScoredPair++;
      continue;
    }
    const honmei = sorted[0];
    const taikou = sorted[1];
    const fp = finishMap.get(`${raceId}:${honmei.car_num}`);
    if (fp == null) {
      skippedNoFinish++;
      continue;
    }
    const lineCount = lineCountOf(raceId);
    if (lineCount == null) {
      skippedNoLineData++;
      continue;
    }
    const members = entriesByRace.get(raceId) ?? [];
    const tokutens = members
      .map((m) => racerMap.get(m.snum)?.heikin_tokuten ?? null)
      .filter((t): t is number => t != null);
    const fieldAvgTokuten = tokutens.length > 0 ? tokutens.reduce((a, b) => a + b, 0) / tokutens.length : null;

    records.push({
      raceId,
      date: honmei.kaisai_date,
      win: fp === 1,
      margin: honmei.total_score - taikou.total_score,
      lineCount,
      honmeiClassRank: racerMap.get(honmei.snum)?.class_rank ?? null,
      honmeiTokuten: racerMap.get(honmei.snum)?.heikin_tokuten ?? null,
      fieldAvgTokuten,
    });
  }

  console.log(`\n対象race数(predictions保存済みwt:レース): ${totalRaces}`);
  console.log(
    `  scored<2除外: ${skippedNoScoredPair} / 本命finish不明除外: ${skippedNoFinish} / ` +
      `entries無し除外: ${skippedNoLineData}`
  );
  console.log(`分析対象レコード数: ${records.length}`);

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`train/test分割日: ${split}（train: <${split}, test: >=${split}）`);

  console.log("\n========== Step1: 分戦数別 本命勝率（中心仮説の再現確認） ==========");
  const labels: Record<number, string> = {
    0: "0(全員単騎/細切れ)",
    1: "1(先行1車)",
    2: "2(二分戦)",
    3: "3(三分戦)",
    4: "4(四分戦)",
  };
  for (const lc of [0, 1, 2, 3, 4]) {
    const subset = records.filter((r) => r.lineCount === lc);
    console.log(`  分戦数${labels[lc]}: ${rateTT(subset, split)}`);
  }
  const threePlus = records.filter((r) => r.lineCount >= 3);
  console.log(`  分戦数3+合算: ${rateTT(threePlus, split)}`);

  const twoLine = records.filter((r) => r.lineCount === 2);
  console.log(
    `\n  参考: 二分戦の平均margin=${(twoLine.reduce((a, r) => a + r.margin, 0) / twoLine.length).toFixed(2)} / ` +
      `三分戦+の平均margin=${(threePlus.reduce((a, r) => a + r.margin, 0) / threePlus.length).toFixed(2)}`
  );

  console.log("\n========== Step2【決定的】: marginで層別（二分戦 vs 三分戦+） ==========");
  const marginBands: [string, (m: number) => boolean][] = [
    ["<5", (m) => m < 5],
    ["5-10", (m) => m >= 5 && m < 10],
    ["10-15", (m) => m >= 10 && m < 15],
    ["15+", (m) => m >= 15],
  ];
  for (const [label, pred] of marginBands) {
    const two = twoLine.filter((r) => pred(r.margin));
    const three = threePlus.filter((r) => pred(r.margin));
    console.log(`  margin${label}:`);
    console.log(`    二分戦　  : ${rateTT(two, split)}`);
    console.log(`    三分戦+  : ${rateTT(three, split)}`);
  }

  console.log("\n========== Step3a: class_rank(本命)で層別 ==========");
  const classGroups: [string, (c: string | null) => boolean][] = [
    ["A1以上(SS/S1/S2/A1)", (c) => c != null && ["SS", "S1", "S2", "A1"].includes(c)],
    ["A2以下(A2/A3)", (c) => c != null && ["A2", "A3"].includes(c)],
  ];
  for (const [label, pred] of classGroups) {
    const two = twoLine.filter((r) => pred(r.honmeiClassRank));
    const three = threePlus.filter((r) => pred(r.honmeiClassRank));
    console.log(`  ${label}:`);
    console.log(`    二分戦　  : ${rateTT(two, split)}`);
    console.log(`    三分戦+  : ${rateTT(three, split)}`);
  }
  console.log("  --- 級班別詳細 ---");
  for (const cr of ["SS", "S1", "S2", "A1", "A2", "A3"]) {
    const two = twoLine.filter((r) => r.honmeiClassRank === cr);
    const three = threePlus.filter((r) => r.honmeiClassRank === cr);
    console.log(`    ${cr}: 二分戦${rate(two)} vs 三分戦+${rate(three)}`);
  }

  console.log("\n========== Step3b: heikin_tokuten(フィールド平均)三分位で層別 ==========");
  const allTokuten = records
    .map((r) => r.fieldAvgTokuten)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const t1 = allTokuten[Math.floor(allTokuten.length / 3)];
  const t2 = allTokuten[Math.floor((allTokuten.length * 2) / 3)];
  console.log(`三分位境界: ${t1.toFixed(1)} / ${t2.toFixed(1)}`);
  const tiers: [string, (t: number | null) => boolean][] = [
    ["低位帯", (t) => t != null && t < t1],
    ["中位帯", (t) => t != null && t >= t1 && t < t2],
    ["高位帯", (t) => t != null && t >= t2],
  ];
  for (const [label, pred] of tiers) {
    const two = twoLine.filter((r) => pred(r.fieldAvgTokuten));
    const three = threePlus.filter((r) => pred(r.fieldAvgTokuten));
    console.log(`  ${label}:`);
    console.log(`    二分戦　  : ${rateTT(two, split)}`);
    console.log(`    三分戦+  : ${rateTT(three, split)}`);
  }

  console.log("\n========== Step3c: margin×class_rankの二重層別（念のため） ==========");
  for (const [mlabel, mpred] of marginBands) {
    for (const [clabel, cpred] of classGroups) {
      const two = twoLine.filter((r) => mpred(r.margin) && cpred(r.honmeiClassRank));
      const three = threePlus.filter((r) => mpred(r.margin) && cpred(r.honmeiClassRank));
      if (two.length + three.length < 10) continue;
      console.log(`  margin${mlabel} × ${clabel}: 二分戦${rate(two)} vs 三分戦+${rate(three)}`);
    }
  }

  console.log(
    "\n========== Step4: 厳選(daily_picks)top10選定のシミュレーション（旧margin順 vs 分戦数調整後margin順） =========="
  );

  type PickCandidate = {
    raceId: number;
    date: string;
    margin: number;
    lineCount: number;
    formation: string[];
    actualCombo: string | null;
    hitOdds: number | null;
  };

  const pickCandidates: PickCandidate[] = [];
  let excludedYosen = 0;
  let excluded9car = 0;
  let excludedNoFormation = 0;

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
    if (lineCount == null) continue;

    const results = resultsByRace.get(raceId) ?? [];
    const odds = oddsByRace.get(raceId) ?? [];
    const actualCombo = resolveActualCombo(results, odds);
    const hitOdds =
      actualCombo != null
        ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null)
        : null;

    pickCandidates.push({
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
    `厳選候補（compute-picks.tsのdailyPicks構築と同じ除外基準）: ${pickCandidates.length}件 ` +
      `（予選除外${excludedYosen} / 9人立て除外${excluded9car} / 本命formation無し除外${excludedNoFormation}）`
  );

  const byDate = new Map<string, PickCandidate[]>();
  for (const c of pickCandidates) {
    const arr = byDate.get(c.date) ?? [];
    arr.push(c);
    byDate.set(c.date, arr);
  }

  const DAILY_PICKS_MIN_MARGIN = 10; // lib/repository.tsのgetDailyPicksと同じ閾値

  // 「上位10件/日」のキャップが実際にどれだけ効いているかを先に確認する。
  // ここが常に10件未満なら、ランキング順を変えるだけの案(a)は選定結果そのものを
  // 一切変えない（該当日の全件がそのまま採用されるため）。
  let daysWithMoreThan10 = 0;
  let totalQualifying = 0;
  for (const [, arr] of byDate) {
    const q = arr.filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN).length;
    totalQualifying += q;
    if (q > 10) daysWithMoreThan10++;
  }
  console.log(
    `\nmargin>=10該当レース: 全${totalQualifying}件 / ${byDate.size}日中、1日で10件を超えた日: ${daysWithMoreThan10}日`
  );
  console.log(
    "→ 10件を超える日がほとんど無ければ、「上位10件」のキャップは実質ほぼ効いておらず、" +
      "ランキング順（案a・案cの並び替えのみ）を変えても選定結果自体は変わらない。"
  );

  type SelResult = { hits: number; races: number; stake: number; payout: number };
  /**
   * eligibleFn: そのレースを「厳選候補」として残すかどうか（案c＝閾値を分戦数別に変える）。
   * rankFn: 残った候補の中でのソートキー（案a＝ランキング順を変える）。
   * 案(a)を試すときはeligibleFnを固定（現行のmargin>=10のまま）してrankFnだけ変える。
   * 案(c)を試すときはrankFnを固定（現行のmargin降順のまま）してeligibleFnだけ変える。
   */
  function evalSelection(
    eligibleFn: (c: PickCandidate) => boolean,
    rankFn: (c: PickCandidate) => number,
    dateFilter: (d: string) => boolean
  ): SelResult {
    let hits = 0,
      races = 0,
      stake = 0,
      payout = 0;
    for (const [date, arr] of byDate) {
      if (!dateFilter(date)) continue;
      const top10 = arr
        .filter(eligibleFn)
        .sort((a, b) => rankFn(b) - rankFn(a))
        .slice(0, 10);
      for (const c of top10) {
        if (c.actualCombo == null) continue; // 未確定は除外（getDailyPicksResultsと同じ）
        races++;
        stake += 100 * c.formation.length;
        if (c.formation.includes(c.actualCombo)) {
          hits++;
          if (c.hitOdds != null) payout += 100 * c.hitOdds;
        }
      }
    }
    return { hits, races, stake, payout };
  }

  function fmtSel(s: SelResult): string {
    const hr = s.races > 0 ? ((100 * s.hits) / s.races).toFixed(1) + "%" : "-";
    const roi = s.stake > 0 ? ((100 * s.payout) / s.stake).toFixed(1) + "%" : "-";
    return `的中${hr}(${s.hits}/${s.races}) 回収率${roi}`;
  }
  function report(label: string, eligibleFn: (c: PickCandidate) => boolean, rankFn: (c: PickCandidate) => number) {
    console.log(`\n--- ${label} ---`);
    console.log(`  全体 ${fmtSel(evalSelection(eligibleFn, rankFn, isAll))}`);
    console.log(`  train ${fmtSel(evalSelection(eligibleFn, rankFn, isTrain))}`);
    console.log(`  test  ${fmtSel(evalSelection(eligibleFn, rankFn, isTest))}`);
  }

  const pickDates = [...byDate.keys()].sort();
  const pickSplit = pickDates[Math.floor(pickDates.length * (2 / 3))];
  console.log(`対象日数: ${pickDates.length}日（train/test分割日: ${pickSplit}）`);

  const isAll = () => true;
  const isTrain = (d: string) => d < pickSplit;
  const isTest = (d: string) => d >= pickSplit;

  const rawMargin = (c: PickCandidate) => c.margin;
  const rawEligible = (c: PickCandidate) => c.margin >= DAILY_PICKS_MIN_MARGIN;

  report("旧（現行）: margin>=10・margin降順", rawEligible, rawMargin);

  console.log(
    "\n※ 上記の通りキャップがほぼ効いていないため、案(a)「ランキング順だけ変える」は" +
      "以下のように現行と（ほぼ）同一になることを先に確認する。"
  );
  const adjMarginRankOnly = (c: PickCandidate) =>
    c.margin + (c.lineCount === 2 ? 5 : c.lineCount >= 3 ? -5 : 0);
  report("案(a) 参考: 閾値は現行のまま、並び順だけ分戦数調整後marginに変更", rawEligible, adjMarginRankOnly);

  console.log(
    "\n========== 案(c): 三分戦+だけ閾値を引き上げる（二分戦はmargin>=10のまま） =========="
  );
  for (const raise of [2, 3, 5, 8]) {
    const eligible = (c: PickCandidate) =>
      c.lineCount >= 3 ? c.margin >= DAILY_PICKS_MIN_MARGIN + raise : c.margin >= DAILY_PICKS_MIN_MARGIN;
    report(`三分戦+の閾値をmargin>=${DAILY_PICKS_MIN_MARGIN + raise}に引き上げ（二分戦は据え置き）`, eligible, rawMargin);
  }

  // なぜROIが悪化するのかの内訳確認: raise=2で「除外される三分戦+」（margin10-12かつ
  // 三分戦+）と「残る全体」を比較する。上位10件キャップは効いていない（daysWithMoreThan10=0）
  // ため、除外分はそのまま選定対象から消えるだけで代わりが入らない。
  const removedByRaise2 = pickCandidates.filter(
    (c) => c.lineCount >= 3 && c.margin >= DAILY_PICKS_MIN_MARGIN && c.margin < DAILY_PICKS_MIN_MARGIN + 2
  );
  {
    let hits = 0,
      stake = 0,
      payout = 0,
      races = 0;
    for (const c of removedByRaise2) {
      if (c.actualCombo == null) continue;
      races++;
      stake += 100 * c.formation.length;
      if (c.formation.includes(c.actualCombo)) {
        hits++;
        if (c.hitOdds != null) payout += 100 * c.hitOdds;
      }
    }
    console.log(
      `\n参考: raise=2で除外される「三分戦+・margin10-12」レース単体の実績: ` +
        `${fmtSel({ hits, races, stake, payout })}（この的中時の払戻が高配当寄りだと、` +
        `除外により全体の回収率だけが下がる＝的中率はさほど落ちない、という上記の結果を説明できる）`
    );
  }

  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
