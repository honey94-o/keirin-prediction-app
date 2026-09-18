import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

/**
 * 【検証結果: 不採用（3着だけ広げるとガールズ抽出分は改善しても厳選ポートフォリオ
 * 全体のROIがtrain/testとも悪化する。非ガールズmargin>=13も3着を広げるほど
 * 一貫してROI悪化、かつ現行のまま既に黒字で「壊れていない」ことを確認）】
 *
 * ■ 背景・問い
 * ユーザーが今週教えてくれたケイリンの格言「3着とトイレは流せ」（3着は1・2着より
 * 本質的に運任せで読みにくいので、3着だけは的中率重視で広く流すべき、という
 * 通説）を検証する。2026-09-18に出した2つの修正（
 * scripts/diagnose-ability-gap-vs-margin.ts＝◎選定側の除外フィルタ、
 * scripts/diagnose-second-third-place-signal.ts＝ガールズの2・3着プール並び順を
 * heikin_tokuten順に変更）とは別の軸で、「プールの中身・順番」ではなく
 * 「プールの幅（2着と3着で非対称に広げるべきか）」を扱う。
 * scripts/diagnose-girls-margin-band.tsは既に「フォーメーション全体の幅を
 * 一律に」広げ縮めして検証済み（結論: 現行の6点が最良）だが、これは2着・3着を
 * 同じ幅で動かす対称な変更であり、「2着は据え置き・3着だけ広げる」非対称な
 * 変更は未検証だった。非ガールズのhonmeiFormationHighMargin（lib/scoring.ts）は
 * margin10-13帯で既に「2着=プール上位2×3着=プール上位8」という非対称形を
 * 採用済みだが、margin>=13帯は「◎→固定2着→3着2択」と再び対称的に絞られており、
 * ここが格言の言う「3着だけ広げる」余地が残っているか、あるいは既に十分かを
 * Step1で定量化してから確かめる。
 *
 * ■ 方法・データ
 * scripts/diagnose-second-third-place-signal.tsが2026-09-18 21:29に生成した
 * predictRaceフルスキャンのキャッシュ（scripts/data/second-third-signal-
 * candidates-cache.json、encp LIKE 'wt:%'・結果確定済み全レース12,269件、
 * 163日20260409〜20260918、train/test分割日20260726）をそのまま再利用した
 * （本セッションで新たにpredictRaceを再スキャンしていない）。
 * 再利用の妥当性確認：(1) 鮮度: 生成日時が今日（2026-09-18）で最終日付も
 * 今日20260918、今日の2修正を反映した最新コードで生成されている。
 * (2) スキーマ: axisWon・actualSecondCar/actualThirdCar・finishPosByCar・
 * nonAxis（heikinTokuten等）・lineAwarePool・totalScorePool・formation・
 * actualCombo・hitOdds・abilityGap・closestKyakushitsu・margin・stage・
 * fieldSize・isGirlsを全件保持しており、本検証（Step1のプール内包判定、
 * Step2の代替フォーメーション再構築、Step3のgetDailyPicks再現）に必要な情報が
 * 揃っている。(3) 整合性チェック: キャッシュのformationフィールドが実際に
 * 現行コードと一致するか実測で検証したところ、非ガールズはmargin>=10母集団
 * 660/660件で現行のhonmeiFormationHighMargin（buildLineAwarePool経由）と
 * 完全一致した（今日の2修正はどちらもbuildLineAwarePool/honmeiFormationHighMargin
 * 自体を変更していないため、これは想定通り）。一方ガールズは、キャッシュの
 * formationフィールドがheikin_tokuten順（本日の修正後）ではなくtotalScore順
 * （修正前）のまま保存されていることが判明した（1055件中639件はheikin_tokuten
 * 上位3とtotalScore上位3が偶然一致するため判別不能だが、残り416件は明確に
 * totalScore順の結果と一致しheikin_tokuten順とは不一致）。そのためガールズの
 * 「現行」はキャッシュのformationフィールドを使わず、保存済みのnonAxis[].
 * heikinTokutenからformationFromPool(axis, pool, budget=10)を都度再構築して
 * 使用した（lib/scoring.tsのgenerateGirlsScenariosと同一ロジック）。
 *
 * ■ Step1【格言の検証】: ◎的中レースを「2着だけ正解/3着だけ正解」で分解
 * 「現行プールに実際の2着・3着それぞれが含まれるか」を、レースごとの実際の
 * フォーメーション買い目（本命シナリオのcombinations）から逆算した
 * secondSet/thirdSet（axis-second-thirdの各要素の集合）で判定した
 * （margin帯で形が変わる非ガールズの非対称フォーメーションにもそのまま対応できる）。
 *
 *   ガールズ（◎的中n=724）:
 *     2着○3着○(的中の必要条件): 63.1%　2着○3着×(3着だけが外す): 22.9%
 *     2着×3着○(2着だけが外す): 11.7%　両方×: 2.2%
 *     P(3着だけが外す | 2着は合っている)  = 26.6%(166/623)
 *     P(2着だけが外す | 3着は合っている)  = 15.7%(85/542)
 *     train: 23.8%(3着) vs 14.4%(2着) / test: 32.0%(3着) vs 18.1%(2着)
 *     → train/testとも一貫して「3着だけが外す」方が「2着だけが外す」より
 *     1.6〜1.8倍多い。格言通り、ガールズでは3着が明確に支配的な失敗要因。
 *
 *   非ガールズ・全margin帯（◎的中n=4536）:
 *     P(3着だけが外す|2着○) = 29.7%　P(2着だけが外す|3着○) = 31.9%
 *     train29.9%/31.5%、test29.4%/32.7% → ほぼ対称、方向もどちらかといえば
 *     2着の方がわずかに多い。格言的な非対称は非ガールズ全体では見えない。
 *
 *   非ガールズ・margin>=10（厳選母集団、◎的中n=512）:
 *     P(3着だけが外す|2着○) = 10.0%(31/311)　P(2着だけが外す|3着○) = 30.2%(121/401)
 *     train8.9%/28.8%、test12.0%/32.6% → train/testとも逆転していて、
 *     margin>=10では「2着だけが外す」方が3倍近く多い。これはhonmeiFormation
 *     HighMarginが既にmargin10-13帯で「2着=上位2×3着=上位8」という非対称形を
 *     採用済みで、3着側は既に十分広く、残る弱点はむしろ2着側であることを示す
 *     （＝「3着だけ広げる」着想は非ガールズmargin>=10では既に先取りされていて
 *     効かない可能性が高いという、ユーザーの読み筋通りの結果）。
 *
 *   ガールズ・margin>=10（◎的中n=214）: 3着25.9% vs 2着14.4%
 *     （train21.6/13.9、test32.4/15.3）→ 全margin帯と同じ方向・同程度の非対称が
 *     margin>=10に絞っても再現する。
 *
 *   結論: 格言はガールズでは実測で裏付けられた（3着が的中を壊す支配的要因、
 *   train/testとも一貫）。非ガールズでは全体では対称、margin>=10母集団では
 *   むしろ逆（2着の方が壊す）で、格言をそのまま適用する根拠は薄い
 *   （honmeiFormationHighMarginが既に3着を広げる非対称形を先に実装済みのため）。
 *   → Step2はガールズの3着拡張を主軸に、非ガールズはmargin>=13枝
 *   （◎→固定2着→3着2択、まだ対称的に絞られている枝）だけ確認する。
 *
 * ■ Step2a: ガールズ 非対称フォーメーション幅の比較（◎的中n=724、プール内包率）
 *   2着top3×3着top3(現行) : 全体63.1% train66.0% test58.0%
 *   2着top2×3着top4      : 全体62.2% train64.9% test57.2%（現行以下）
 *   2着top2×3着top5      : 全体67.5% train68.7% test65.4%
 *   2着top2×3着top6      : 全体69.9% train70.4% test68.9%
 *   2着top3×3着top4      : 全体76.7% train79.7% test71.2%
 *   2着top3×3着top5      : 全体83.4% train84.6% test81.3%
 *   2着top3×3着top6      : 全体86.0% train86.5% test85.2%
 *   → 2着を3のまま据え置き3着だけ広げる形が、2着自体を2に狭める形より
 *   一貫して内包率が高い（格言通り「2着は精度重視のまま、3着だけ広げる」形が
 *   構造的に正しい方向）。ただし内包率が上がるほど点数（賭け金）も増えるため、
 *   ROIで最終判断する。
 *
 *   ガールズmargin>=10母集団（n=232）でのROI（flat、day-by-day選定前の生数値）:
 *     現行(3×3,6点)   : 全体91.9% train100.3% test78.7%
 *     2×4(6点)        : 全体80.8% train80.8% test80.9%
 *     2×5(8点)        : 全体75.9% train68.1% test88.3%
 *     2×6(10点)       : 全体74.2% train61.7% test93.7%
 *     3×4(9点)        : 全体90.0% train85.4% test97.2%
 *     3×5(12点)       : 全体82.0% train76.1% test91.3%
 *     3×6(15点)       : 全体74.8% train66.0% test88.5%
 *   → 的中率はどの候補も現行超えだが、ROIは現行(91.9%)を上回る候補が無く、
 *   train/testの方向もバラバラ（3×4はtrain悪化・test改善で方向不一致）。
 *   典型的な「的中率は上がるがROIが伴わない」パターン。
 *
 * ■ Step2b: 非ガールズ margin>=13枝（現行=◎→固定2着→3着2択）の3着拡大
 *   （n=258、◎的中220件、flat集計）
 *     3着2択(現行): 全体的中35.3%回収率92.6% train101.6% test80.1%
 *     3着3択      : 全体的中40.3%回収率79.0% train80.0% test77.4%
 *     3着4択      : 全体的中42.6%回収率62.8% train65.0% test59.7%
 *     3着5択      : 全体的中47.3%回収率68.6% train68.1% test69.4%
 *     3着6択      : 全体的中47.3%回収率68.6%（5択と同値＝出走頭数の上限で頭打ち）
 *   → 的中率は単調に上がるが回収率は単調に悪化（train/testとも同方向で明確）。
 *   margin10-13枝の3着プール（現行8）を10/12/15に広げても数値は完全に不変
 *   だった（n=402、実際の出走頭数の上限で元々ほぼ全員を含んでおり、広げる余地が
 *   構造的に無い）。さらに、実際のgetDailyPicks選定（top10/日）内でmargin>=13枝
 *   だけを抽出すると現行のまま回収率116.3%（train118.4%/test113.6%、
 *   両期間とも黒字）で、「margin>=13枝が3着を絞りすぎて損している」という
 *   仮説自体が実測で否定された。→ 非ガールズは現状維持、3着を広げる根拠なし。
 *
 * ■ Step3【決定的】: 厳選(daily_picks) day-by-day選定シミュレーション
 *   （margin>=10・上位10件/日、raceStage==='予選'除外・9人立て除外・
 *   ABILITY_GAP_THIN_THRESHOLD除外を完全再現。ガールズのみ候補幅に置換、
 *   非ガールズはStep2bの結果によりStep3では変更しない）
 *   全ピック母集団n=265（train179/test86）、ガールズ抽出分n=59（train39/test20）。
 *
 *   baseline（現行、両修正込み）:
 *     全体　　: 回収率147.0%(train119.2%/test215.0%)
 *     ガールズ抽出分: 回収率95.1%(train90.0%/test105.0%)
 *   候補: ガールズのみ2着top3×3着top4:
 *     全体141.4%(train114.5%/test205.7%) ← 全体train/testとも悪化
 *     ガールズ抽出分90.8%(train80.6%/test110.7%) ← trainさらに悪化、
 *     testのみ改善で方向不一致
 *   候補: ガールズのみ2着top2×3着top5:
 *     全体144.6%(train118.4%/test207.4%) ← 全体train/testとも悪化（小幅）
 *     ガールズ抽出分97.6%(train93.8%/test105.1%) ← train改善・testほぼ横ばい
 *   候補: ガールズのみ2着top2×3着top6:
 *     全体136.8%(train112.4%/test194.7%) ← 全体train/testとも悪化
 *     ガールズ抽出分78.9%(train75.8%/test84.9%) ← 両期間とも悪化、明確に不採用
 *   候補: ガールズのみ2着top3×3着top5:
 *     全体140.9%(train115.9%/test199.7%) ← 全体train/testとも悪化
 *     ガールズ抽出分101.9%(train93.7%/test117.9%) ← ガールズ抽出分だけ見ると
 *     train/testとも改善（黒字転換に近づく）が、全体ポートフォリオは
 *     train/testとも悪化する
 *
 *   → 4候補すべてで「全体（非ガールズ込みの実際の厳選ポートフォリオ）が
 *   train/testとも悪化しない」という採用基準（diagnose-second-third-place-
 *   signal.tsで実際に適用した基準と同じ）を満たさなかった。ガールズ抽出分
 *   だけを見ればtop3×top5がtrain/testとも改善する唯一の候補だが、3着を
 *   広げた分だけ賭け金（点数）が増え、その増分が非ガールズも含む全体の
 *   高い回収率（119-215%）を薄める形で全体を押し下げる。「3着だけ広げると
 *   ガールズ抽出分の的中は増えるが、増分の払戻がその点数増加分の投資を
 *   上回るほどではない」というROI上のトレードオフが実測で確認できた。
 *
 * ■ 結論: 不採用
 * Step1で「3着が2着より的中を壊す支配的要因」という格言の主張自体はガールズに
 * 限って実測で裏付けられた（train/testとも一貫、非ガールズでは支持されない）。
 * しかしStep2・Step3のROI検証では、3着プールを広げるどの幅の組み合わせも
 * 「ガールズ抽出分は改善するが全体ポートフォリオがtrain/testとも悪化する」
 * （2着top3×3着top5が最良候補だがこれに該当）か、「ガールズ抽出分自体も
 * train/testの方向が割れる／悪化する」（他の3候補）のいずれかで、この
 * プロジェクトの採用基準（対象単体だけでなく全体もtrain/testとも悪化しない
 * こと）を満たす候補は無かった。非ガールズのhonmeiFormationHighMargin
 * margin>=13枝も、3着を広げるほど回収率が単調に悪化し、かつ現状のまま
 * 実運用で黒字（116.3%）であることが確認できたため変更不要と判断した。
 * lib/scoring.ts・scripts/compute-picks.tsへの変更は行っていない
 * （現状維持）。「3着とトイレは流せ」は定性的な傾向としては本物だが、
 * このプロジェクトの実運用の点数配分（点数を増やすほど賭け金が線形に増える
 * 3連単フォーメーション）では、既に十分な精度で絞られた2着プールと
 * 組み合わせる限り、3着だけをさらに広げる追加投資に見合うリターンが
 * 出なかった、という「本物のパターンだが実利に乗らない」タイプの結果
 * （scripts/diagnose-barikata-expansion.ts・scripts/diagnose-senko-issha.ts
 * と同種）。
 *
 * 残る留保点: (1) ガールズ抽出分のn=59（train39/test20）は薄く、2着top3×
 * 3着top5のtest改善(+12.9pt)が少数の高配当的中に引っ張られている可能性がある。
 * (2) train/test分割は1本のみ。(3) 「幅を一律N倍する」比較のみ行っており、
 * レース属性（フィールドサイズ・abilityGap等）で層別して一部レースだけ3着を
 * 広げるといった、より粒度の細かい条件付き拡張は未検証。
 */

import { getDb, closeDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { raceStage, buildLineAwarePool } from "../lib/scoring";
import {
  getResultsForRace,
  getOddsForRace,
  resolveActualCombo,
  enableReadCache,
} from "../lib/repository";

const DAILY_PICKS_MIN_MARGIN = 10;
const ABILITY_GAP_THIN_THRESHOLD = 5;
const GIRLS_BUDGET = 10;
const HIGH_MARGIN_TIGHT_THRESHOLD = 13;

// 既定で再利用するキャッシュ（scripts/diagnose-second-third-place-signal.tsが
// 2026-09-18に生成、鮮度・スキーマとも確認済み。ヘッダーコメント参照）。
const DEFAULT_CACHE_PATH = path.join(
  process.cwd(),
  "scripts",
  "data",
  "second-third-signal-candidates-cache.json"
);

// ============ formationFromPool / honmeiFormationHighMargin 等
// (lib/scoring.ts、非export) の複製 ============
function formationFromPool(axis: number, orderedPool: number[], maxPoints: number): string[] {
  if (orderedPool.length < 2) return [];
  let poolSize = 2;
  for (let m = 2; m <= orderedPool.length; m++) {
    if (m * (m - 1) > maxPoints) break;
    poolSize = m;
  }
  const candidates = orderedPool.slice(0, poolSize);
  const combos: string[] = [];
  for (const second of candidates) {
    for (const third of candidates) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

/** margin>=13枝（現行）: ◎→固定2着(pool[0])→3着はpool[1..2]の2択。 */
function honmeiTight2(axis: number, pool: number[]): string[] {
  const second = pool[0];
  if (second == null) return [];
  return pool
    .slice(1, 3)
    .filter((t) => t !== second)
    .map((t) => `${axis}-${second}-${t}`);
}

/** 候補: margin>=13枝、同じ固定2着のまま3着候補をthirdCount頭に拡大。 */
function honmeiWidenThirdTight(axis: number, pool: number[], thirdCount: number): string[] {
  const second = pool[0];
  if (second == null) return [];
  return pool
    .slice(1, 1 + thirdCount)
    .filter((t) => t !== second)
    .map((t) => `${axis}-${second}-${t}`);
}

/** 候補: margin10-13枝、2着上位2×3着上位thirdCount（現行8）。 */
function honmeiWidenThirdMid(axis: number, pool: number[], thirdCount: number): string[] {
  const seconds = pool.slice(0, 2);
  const thirds = pool.slice(0, thirdCount);
  const combos: string[] = [];
  for (const second of seconds) {
    for (const third of thirds) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

/** ガールズ候補: 2着候補secondSize頭×3着候補thirdSize頭（非対称、budget無視）。 */
function girlsAsymmetric(axis: number, pool: number[], secondSize: number, thirdSize: number): string[] {
  const seconds = pool.slice(0, secondSize);
  const thirds = pool.slice(0, thirdSize);
  const combos: string[] = [];
  for (const second of seconds) {
    for (const third of thirds) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

type NonAxisEntry = {
  carNum: number;
  totalScore: number;
  heikinTokuten: number | null;
  rentairitu2: number | null;
  rentairitu3: number | null;
  kyakushitsu: string | null;
  linePosition: string | null;
  lineGroup: number | null;
  standingCount: number | null;
  backLeadCount: number | null;
  homeLeadCount: number | null;
};

type Rec = {
  raceId: number;
  date: string;
  isGirls: boolean;
  fieldSize: number;
  margin: number;
  stage: string;
  axisCarNum: number;
  axisLineGroup: number | null;
  axisWon: boolean;
  actualSecondCar: number | null;
  actualThirdCar: number | null;
  finishPosByCar: Record<number, number | null>;
  nonAxis: NonAxisEntry[];
  lineAwarePool: number[];
  totalScorePool: number[]; // ガールズの旧(totalScore順)プール。今回は未使用（ヘッダー参照）
  formation: string[]; // キャッシュ生成時点の本命フォーメーション（非ガールズは現行と一致確認済み、ガールズは不使用）
  actualCombo: string | null;
  hitOdds: number | null;
  abilityGap: number | null;
  closestKyakushitsu: string | null;
};

/** 素点(heikin_tokuten)降順プール（欠損時はtotalScoreにフォールバック）。
 * generateGirlsScenarios（lib/scoring.ts、本日の修正後）と同一ロジック。 */
function sortedPoolHeikin(nonAxis: NonAxisEntry[]): number[] {
  return [...nonAxis]
    .sort((a, b) => {
      const av = a.heikinTokuten;
      const bv = b.heikinTokuten;
      if (av == null && bv == null) return b.totalScore - a.totalScore;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    })
    .map((e) => e.carNum);
}

/** レースの「現行」本命フォーメーション。ガールズはキャッシュのformationが
 * 旧ロジック(totalScore順)のままのため使わずheikin_tokuten順で再構築する
 * （ヘッダーコメントの整合性チェック参照）。非ガールズはキャッシュのformationを
 * そのまま使う（margin>=10母集団660/660件で現行ロジックと完全一致を確認済み）。 */
function currentFormationOf(r: Rec): string[] {
  return r.isGirls ? formationFromPool(r.axisCarNum, sortedPoolHeikin(r.nonAxis), GIRLS_BUDGET) : r.formation;
}

function isEligible(r: Rec): boolean {
  if (r.stage === "予選") return false;
  if (r.fieldSize === 9) return false;
  if (r.margin < DAILY_PICKS_MIN_MARGIN) return false;
  if (r.abilityGap != null && r.abilityGap < ABILITY_GAP_THIN_THRESHOLD) {
    if (r.closestKyakushitsu === "逃" || r.closestKyakushitsu === "両") return false;
  }
  return true;
}

const CACHE_ARG_PREFIX = "--from-cache=";

async function main() {
  const fromCacheArg = process.argv.find((a) => a.startsWith(CACHE_ARG_PREFIX));
  const rescan = process.argv.includes("--rescan");
  let records: Rec[];

  if (!rescan) {
    const cachePath = fromCacheArg ? fromCacheArg.slice(CACHE_ARG_PREFIX.length) : DEFAULT_CACHE_PATH;
    if (!existsSync(cachePath)) {
      throw new Error(`キャッシュが見つかりません: ${cachePath}（--rescanで新規スキャンするか、正しいパスを--from-cacheで指定してください）`);
    }
    console.log(`キャッシュから読込: ${cachePath}`);
    records = JSON.parse(readFileSync(cachePath, "utf-8")) as Rec[];
    console.log(`読込完了: ${records.length}件`);
  } else {
    records = await scanAllRaces();
    const cacheOutArg = process.argv.find((a) => a.startsWith("--cache-out="));
    const cacheOutPath = cacheOutArg
      ? cacheOutArg.slice("--cache-out=".length)
      : path.join(process.cwd(), "scripts", "data", "third-place-widen-candidates-cache.json");
    writeFileSync(cacheOutPath, JSON.stringify(records));
    console.log(`候補データをキャッシュ保存: ${cacheOutPath}`);
  }

  runAnalysis(records);
  await closeDb();
}

// scripts/diagnose-second-third-place-signal.tsのscanAllRacesと同一実装
// （Recのスキーマを完全に揃えているため、そちらのキャッシュをそのまま読み込める。
// このスクリプト単体でも--rescanで再現できるように残してある）。
async function scanAllRaces(): Promise<Rec[]> {
  enableReadCache();
  const db = getDb();
  const res = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL AND ra.encp LIKE 'wt:%' ORDER BY r.race_id`
  );
  let ids = (res.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limArg = process.argv.find((a) => a.startsWith("--limit="));
  if (limArg) ids = ids.slice(-Number(limArg.split("=")[1]));
  console.log(`対象race: ${ids.length}件`);

  const records: Rec[] = [];
  let excludedSmallField = 0;
  let excludedNoResult = 0;
  let excludedError = 0;

  async function predictRaceWithRetry(raceId: number, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await predictRace(raceId);
      } catch (err) {
        if (attempt === attempts) {
          console.warn(`  race ${raceId}: predictRace失敗（${attempts}回リトライ後も失敗）: ${err}`);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    return undefined;
  }

  const BATCH = 25;
  const startTime = Date.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const out = await Promise.all(
      chunk.map(async (raceId): Promise<Rec | null> => {
        const p = await predictRaceWithRetry(raceId);
        if (p === undefined) {
          excludedError++;
          return null;
        }
        if (!p || p.scored.length < 3) {
          excludedSmallField++;
          return null;
        }
        const { scored } = p;
        const isGirls = scored.some((s) => s.entry.class_rank?.startsWith("L"));
        const axis = scored[0];
        const taikou = scored[1];
        const margin = axis.totalScore - taikou.totalScore;
        const stage = raceStage(p.race.syumoku);
        const honmeiScenario = p.scenarios.find((s) => s.label === "本命");

        let results, odds;
        try {
          [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
        } catch (err) {
          console.warn(`  race ${raceId}: results/odds取得失敗: ${err}`);
          excludedError++;
          return null;
        }
        const actualCombo = resolveActualCombo(results, odds);
        if (actualCombo == null) {
          excludedNoResult++;
          return null;
        }
        const [p1, p2, p3] = actualCombo.split("-").map(Number);
        const axisWon = p1 === axis.entry.car_num;
        const hitOdds =
          odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;

        const finishPosByCar: Record<number, number | null> = {};
        for (const r of results) finishPosByCar[r.car_num] = r.finish_pos;

        const nonAxisScored = scored.filter((s) => s.entry.car_num !== axis.entry.car_num);
        const nonAxis: NonAxisEntry[] = nonAxisScored.map((s) => ({
          carNum: s.entry.car_num,
          totalScore: s.totalScore,
          heikinTokuten: s.entry.heikin_tokuten,
          rentairitu2: s.entry.rentairitu2,
          rentairitu3: s.entry.rentairitu3,
          kyakushitsu: s.entry.kyakushitsu,
          linePosition: s.entry.line_position,
          lineGroup: s.entry.line_group,
          standingCount: s.entry.standing_count,
          backLeadCount: s.entry.back_lead_count,
          homeLeadCount: s.entry.home_lead_count,
        }));

        const lineAwarePool = buildLineAwarePool(axis.entry.car_num, axis.entry.line_group, scored);
        const totalScorePool = [...nonAxisScored]
          .sort((a, b) => b.totalScore - a.totalScore)
          .map((s) => s.entry.car_num);

        let abilityGap: number | null = null;
        let closestKyakushitsu: string | null = null;
        const others = scored.slice(1);
        const hasAllTokuten =
          axis.entry.heikin_tokuten != null && others.every((o) => o.entry.heikin_tokuten != null);
        if (hasAllTokuten) {
          let closest = others[0];
          for (const o of others) {
            if ((o.entry.heikin_tokuten as number) > (closest.entry.heikin_tokuten as number)) closest = o;
          }
          abilityGap = (axis.entry.heikin_tokuten as number) - (closest.entry.heikin_tokuten as number);
          closestKyakushitsu = closest.entry.kyakushitsu;
        }

        return {
          raceId,
          date: p.race.kaisai_date,
          isGirls,
          fieldSize: scored.length,
          margin,
          stage,
          axisCarNum: axis.entry.car_num,
          axisLineGroup: axis.entry.line_group,
          axisWon,
          actualSecondCar: axisWon ? p2 : null,
          actualThirdCar: axisWon ? p3 : null,
          finishPosByCar,
          nonAxis,
          lineAwarePool,
          totalScorePool,
          formation: honmeiScenario?.formation.combinations ?? [],
          actualCombo,
          hitOdds,
          abilityGap,
          closestKyakushitsu,
        };
      })
    );
    for (const o of out) if (o) records.push(o);
    if ((i / BATCH) % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  進捗 ${Math.min(i + BATCH, ids.length)}/${ids.length} (${elapsed}s経過)`);
    }
  }

  console.log(
    `\n候補生成完了: ${records.length}件（scored<3除外${excludedSmallField} / 結果未確定除外${excludedNoResult} / DBエラー除外${excludedError}）`
  );
  return records;
}

// ============ 解析 ============

function pct(n: number, d: number): string {
  return d > 0 ? ((100 * n) / d).toFixed(1) + "%" : "-";
}

function splitDateOf(records: Rec[]): string {
  const dates = [...new Set(records.map((r) => r.date))].sort();
  return dates[Math.floor(dates.length * (2 / 3))];
}

/** レースの実際のフォーメーション買い目から、axis起点の2着候補集合・3着候補集合を逆算する。
 * margin帯で形が変わる非ガールズの非対称/ボックス形フォーメーションにも一般的に対応できる
 * （ボックス形は「axisが実際に1着」の前提下では見かけ上の2着候補が1台に絞られるだけ）。 */
function poolSetsFromFormation(axisCarNum: number, formation: string[]) {
  const prefix = `${axisCarNum}-`;
  const secondSet = new Set<number>();
  const thirdSet = new Set<number>();
  for (const combo of formation) {
    if (!combo.startsWith(prefix)) continue;
    const [second, third] = combo.slice(prefix.length).split("-").map(Number);
    secondSet.add(second);
    thirdSet.add(third);
  }
  return { secondSet, thirdSet };
}

function runAnalysis(records: Rec[]): void {
  const splitDate = splitDateOf(records);
  const dates = [...new Set(records.map((r) => r.date))].sort();
  console.log(`\n対象日数: ${dates.length}日（${dates[0]}〜${dates.at(-1)}） train/test分割日: ${splitDate}`);

  const girls = records.filter((r) => r.isGirls);
  const nonGirls = records.filter((r) => !r.isGirls);
  console.log(`全レース: ${records.length}件（ガールズ${girls.length}件 / 非ガールズ${nonGirls.length}件）`);

  console.log("\n========== Step1: 「2着だけ外す/3着だけ外す」の非対称性 ==========");

  function step1(subset: Rec[], label: string) {
    const won = subset.filter((r) => r.axisWon);
    let both = 0,
      secondOnly = 0,
      thirdOnly = 0,
      neither = 0;
    for (const r of won) {
      const form = currentFormationOf(r);
      const { secondSet, thirdSet } = poolSetsFromFormation(r.axisCarNum, form);
      const secondOk = secondSet.has(r.actualSecondCar as number);
      const thirdOk = thirdSet.has(r.actualThirdCar as number);
      if (secondOk && thirdOk) both++;
      else if (secondOk && !thirdOk) secondOnly++;
      else if (!secondOk && thirdOk) thirdOnly++;
      else neither++;
    }
    const n = won.length;
    console.log(`\n--- ${label}（◎的中 n=${n}） ---`);
    console.log(
      `  両方○${pct(both, n)}(${both}) / 3着だけ×${pct(secondOnly, n)}(${secondOnly}) / ` +
        `2着だけ×${pct(thirdOnly, n)}(${thirdOnly}) / 両方×${pct(neither, n)}(${neither})`
    );
    console.log(`  P(3着だけが外す|2着○) = ${pct(secondOnly, secondOnly + both)} (${secondOnly}/${secondOnly + both})`);
    console.log(`  P(2着だけが外す|3着○) = ${pct(thirdOnly, thirdOnly + both)} (${thirdOnly}/${thirdOnly + both})`);
    for (const [tlabel, pred] of [
      ["train", (d: string) => d < splitDate],
      ["test", (d: string) => d >= splitDate],
    ] as const) {
      const sub = won.filter((r) => pred(r.date));
      let b = 0,
        s2 = 0,
        t2 = 0;
      for (const r of sub) {
        const form = currentFormationOf(r);
        const { secondSet, thirdSet } = poolSetsFromFormation(r.axisCarNum, form);
        const secondOk = secondSet.has(r.actualSecondCar as number);
        const thirdOk = thirdSet.has(r.actualThirdCar as number);
        if (secondOk && thirdOk) b++;
        else if (secondOk && !thirdOk) s2++;
        else if (!secondOk && thirdOk) t2++;
      }
      console.log(
        `    [${tlabel}] n=${sub.length} P(3着だけ|2着○)=${pct(s2, s2 + b)}(${s2}/${s2 + b}) ` +
          `P(2着だけ|3着○)=${pct(t2, t2 + b)}(${t2}/${t2 + b})`
      );
    }
  }

  step1(girls, "ガールズ");
  step1(nonGirls, "非ガールズ（全margin帯）");
  step1(
    nonGirls.filter((r) => r.margin >= DAILY_PICKS_MIN_MARGIN),
    "非ガールズ（margin>=10、厳選母集団）"
  );
  step1(
    girls.filter((r) => r.margin >= DAILY_PICKS_MIN_MARGIN),
    "ガールズ（margin>=10、厳選母集団）"
  );

  console.log("\n========== Step2a: ガールズ 非対称プール幅の比較（プール内包率） ==========");
  const girlsWon = girls.filter((r) => r.axisWon);
  console.log(`ガールズ◎的中 n=${girlsWon.length}`);

  function jointRateAsym(subset: Rec[], secondSize: number, thirdSize: number): number {
    let j = 0;
    for (const r of subset) {
      const pool = sortedPoolHeikin(r.nonAxis);
      const seconds = new Set(pool.slice(0, secondSize));
      const thirds = new Set(pool.slice(0, thirdSize));
      if (
        seconds.has(r.actualSecondCar as number) &&
        thirds.has(r.actualThirdCar as number) &&
        r.actualSecondCar !== r.actualThirdCar
      )
        j++;
    }
    return j;
  }
  const widthCombos: [number, number][] = [
    [3, 3],
    [2, 4],
    [2, 5],
    [2, 6],
    [3, 4],
    [3, 5],
    [3, 6],
  ];
  const train1 = girlsWon.filter((r) => r.date < splitDate);
  const test1 = girlsWon.filter((r) => r.date >= splitDate);
  for (const [ss, ts] of widthCombos) {
    const jAll = jointRateAsym(girlsWon, ss, ts);
    const jTr = jointRateAsym(train1, ss, ts);
    const jTe = jointRateAsym(test1, ss, ts);
    console.log(
      `  2着top${ss}×3着top${ts}${ss === 3 && ts === 3 ? "(現行)" : ""}: 全体${pct(jAll, girlsWon.length)}(${jAll}/${girlsWon.length}) train${pct(jTr, train1.length)} test${pct(jTe, test1.length)}`
    );
  }

  function evalFormationBuilder(subset: Rec[], build: (r: Rec) => string[], label: string) {
    const parts: string[] = [];
    for (const [tlabel, pred] of [
      ["全体", () => true],
      ["train", (d: string) => d < splitDate],
      ["test", (d: string) => d >= splitDate],
    ] as const) {
      const sub = subset.filter((r) => pred(r.date));
      let stake = 0,
        payout = 0,
        hits = 0,
        races = 0;
      for (const r of sub) {
        if (r.actualCombo == null) continue;
        const form = build(r);
        races++;
        stake += 100 * form.length;
        if (form.includes(r.actualCombo)) {
          hits++;
          if (r.hitOdds != null) payout += 100 * r.hitOdds;
        }
      }
      const roi = stake > 0 ? ((100 * payout) / stake).toFixed(1) + "%" : "-";
      parts.push(`${tlabel}:的中${pct(hits, races)}(${hits}/${races})回収率${roi}`);
    }
    console.log(`  ${label}: ${parts.join(" / ")}`);
  }

  console.log("\n--- ガールズ margin>=10母集団でのROI（flat、day-by-day選定前） ---");
  const girlsM10 = girls.filter((r) => r.margin >= DAILY_PICKS_MIN_MARGIN);
  console.log(`n=${girlsM10.length}`);
  for (const [ss, ts] of widthCombos) {
    evalFormationBuilder(
      girlsM10,
      (r) => girlsAsymmetric(r.axisCarNum, sortedPoolHeikin(r.nonAxis), ss, ts),
      `2着top${ss}×3着top${ts}${ss === 3 && ts === 3 ? "(現行)" : ""}`
    );
  }

  console.log("\n========== Step2b: 非ガールズ margin>=13枝の3着拡大（flat） ==========");
  const tight = nonGirls.filter((r) => r.margin >= HIGH_MARGIN_TIGHT_THRESHOLD);
  console.log(`margin>=13 n=${tight.length}（◎的中${tight.filter((r) => r.axisWon).length}件）`);
  for (const K of [2, 3, 4, 5, 6]) {
    evalFormationBuilder(
      tight,
      (r) => honmeiWidenThirdTight(r.axisCarNum, r.lineAwarePool, K),
      `3着候補${K}頭${K === 2 ? "(現行)" : ""}`
    );
  }

  console.log("\n--- 参考: margin10-13枝の3着プール(現行8)を拡大 ---");
  const midband = nonGirls.filter((r) => r.margin >= 10 && r.margin < HIGH_MARGIN_TIGHT_THRESHOLD);
  console.log(`margin10-13 n=${midband.length}`);
  for (const K of [8, 10, 12, 15]) {
    evalFormationBuilder(
      midband,
      (r) => honmeiWidenThirdMid(r.axisCarNum, r.lineAwarePool, K),
      `3着候補${K}頭${K === 8 ? "(現行)" : ""}`
    );
  }

  console.log("\n--- 参考: 現行のgetDailyPicks選定内でmargin>=13枝/margin10-13枝を抽出した実績 ---");
  function simulateBandExtract(bandFilter: (r: Rec) => boolean) {
    const byDate = new Map<string, Rec[]>();
    for (const r of records) {
      if (!isEligible(r)) continue;
      const arr = byDate.get(r.date) ?? [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    for (const [tlabel, pred] of [
      ["全体", () => true],
      ["train", (d: string) => d < splitDate],
      ["test", (d: string) => d >= splitDate],
    ] as const) {
      let hits = 0,
        races = 0,
        stake = 0,
        payout = 0;
      for (const [date, arr] of byDate) {
        if (!pred(date)) continue;
        const top10 = [...arr].sort((a, b) => b.margin - a.margin).slice(0, 10);
        for (const r of top10) {
          if (!bandFilter(r) || r.actualCombo == null) continue;
          races++;
          stake += 100 * r.formation.length;
          if (r.formation.includes(r.actualCombo)) {
            hits++;
            if (r.hitOdds != null) payout += 100 * r.hitOdds;
          }
        }
      }
      const roi = stake > 0 ? ((100 * payout) / stake).toFixed(1) + "%" : "-";
      console.log(`    [${tlabel}] 的中${pct(hits, races)}(${hits}/${races}) 回収率${roi}`);
    }
  }
  console.log("  margin>=13枝（非ガールズ、現行のまま）:");
  simulateBandExtract((r) => !r.isGirls && r.margin >= 13);
  console.log("  margin10-13枝（非ガールズ、現行のまま）:");
  simulateBandExtract((r) => !r.isGirls && r.margin >= 10 && r.margin < 13);

  console.log("\n========== Step3: 厳選(daily_picks) day-by-day選定シミュレーション ==========");
  runStep3Simulation(records, splitDate);
}

function runStep3Simulation(records: Rec[], splitDate: string): void {
  type Variant = { label: string; formationFor: (r: Rec) => string[] };
  const baseline: Variant = {
    label: "baseline(現行、両修正込み)",
    formationFor: (r) => currentFormationOf(r),
  };
  function girlsVariant(ss: number, ts: number): Variant {
    return {
      label: `候補: ガールズのみ2着top${ss}×3着top${ts}に置換`,
      formationFor: (r) =>
        r.isGirls ? girlsAsymmetric(r.axisCarNum, sortedPoolHeikin(r.nonAxis), ss, ts) : r.formation,
    };
  }
  const variants: Variant[] = [
    baseline,
    girlsVariant(3, 4),
    girlsVariant(2, 5),
    girlsVariant(2, 6),
    girlsVariant(3, 5),
  ];

  function simulate(variant: Variant, dateFilter: (d: string) => boolean, girlsOnly: boolean) {
    const byDate = new Map<string, Rec[]>();
    for (const r of records) {
      if (!dateFilter(r.date)) continue;
      if (!isEligible(r)) continue;
      const arr = byDate.get(r.date) ?? [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    let races = 0,
      hits = 0,
      stake = 0,
      payout = 0,
      picks = 0,
      days = 0;
    for (const [, arr] of byDate) {
      days++;
      const top10 = [...arr].sort((a, b) => b.margin - a.margin).slice(0, 10);
      for (const r of top10) {
        if (girlsOnly && !r.isGirls) continue;
        picks++;
        if (r.actualCombo == null) continue;
        const formation = variant.formationFor(r);
        races++;
        stake += 100 * formation.length;
        if (formation.includes(r.actualCombo)) {
          hits++;
          if (r.hitOdds != null) payout += 100 * r.hitOdds;
        }
      }
    }
    return { races, hits, stake, payout, picks, days };
  }
  function fmt(s: ReturnType<typeof simulate>): string {
    const hr = s.races > 0 ? ((100 * s.hits) / s.races).toFixed(1) + "%" : "-";
    const roi = s.stake > 0 ? ((100 * s.payout) / s.stake).toFixed(1) + "%" : "-";
    return `的中${hr}(${s.hits}/${s.races}) 回収率${roi} 1日平均${(s.picks / Math.max(1, s.days)).toFixed(2)}件`;
  }

  const isAllD = () => true;
  const isTrainD = (d: string) => d < splitDate;
  const isTestD = (d: string) => d >= splitDate;

  for (const v of variants) {
    console.log(`\n--- ${v.label} ---`);
    console.log(`  [全体日次選定・全レース] 全体 ${fmt(simulate(v, isAllD, false))}`);
    console.log(`  [全体日次選定・全レース] train ${fmt(simulate(v, isTrainD, false))}`);
    console.log(`  [全体日次選定・全レース] test  ${fmt(simulate(v, isTestD, false))}`);
    console.log(`  [同選定中・ガールズのみ抽出] 全体 ${fmt(simulate(v, isAllD, true))}`);
    console.log(`  [同選定中・ガールズのみ抽出] train ${fmt(simulate(v, isTrainD, true))}`);
    console.log(`  [同選定中・ガールズのみ抽出] test  ${fmt(simulate(v, isTestD, true))}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
