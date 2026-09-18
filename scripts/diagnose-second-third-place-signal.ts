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
 * 【検証結果: 採用（lib/scoring.tsのgenerateGirlsScenariosで2・3着候補プールの
 * 並び順をtotalScore→heikin_tokuten（素点）に変更済み、未コミット）】
 *
 * ■ 背景・問い
 * 2026-09-17/18の厳選(daily_picks, margin>=10)手動レビューで、ガールズケイリンに
 * 限って「◎(scored[0])自体は的中しているのに、2着がtotalScore非軸ランキングの
 * 4位以下（時に最下位）から来てフォーメーションを外す」パターンが複数見つかった
 * （青森2R race_id=27421・いわき平6R race_id=27434・岸和田5R race_id=27379・
 * 伊東1R race_id=27988）。これは前日発見の「abilityGap薄い×逃/両ライバルが
 * ◎自体を負かす」問題（scripts/diagnose-ability-gap-vs-margin.ts、◎選定側の
 * 問題）とは別の話で、◎が当たった前提で「2着・3着候補プール」自体の質を問う。
 * generateGirlsScenarios（lib/scoring.ts）はライン構造が無いガールズ向けに
 * 非軸を総合スコア(totalScore)降順でプール化しformationFromPool(budget=10→
 * 実質poolSize3・6点)を組んでいる。この並び順が本当に2着・3着の最良の予測因子か、
 * 別の指標（racers.rentairitu2/3・heikin_tokuten・lineupOrderScore系）の方が
 * 優れているかを検証した。あわせて非ガールズのbuildLineAwarePool（ライン内は
 * lineupOrderScore順）についても同じ問いを軽く検証した（Step3、副次確認）。
 *
 * ■ 方法
 * predictRace（lib/predict.ts）をencp LIKE 'wt:%'・結果確定済み全レースに対して
 * フルスキャンした（diagnose-ability-gap-vs-margin.tsと同じ母集団定義・同じ
 * predictRaceWithRetry方式）。「◎が実際に1着で的中」した場合に限定し
 * （◎選定自体の精度は別問題として切り離す、ユーザー指示通り）、非軸選手を
 * 各候補シグナルで降順に並べたプールに、実際の2着・3着の両方が上位3以内に
 * 収まるか（=6点フォーメーションが構造的に的中しうる必要条件）を比較した。
 * train/testは開催日で2/3・1/3にクロノロジカル分割（このプロジェクトの標準）。
 * Step4では実際のgetDailyPicks選定（margin>=10・day-by-day top10/日、
 * scripts/compute-picks.tsのraceStage()==='予選'除外・9人立て除外・
 * ABILITY_GAP_THIN_THRESHOLD除外フィルタを完全複製）を再現し、ガールズの
 * フォーメーションだけを候補シグナルで組み直した場合の回収率を比較した。
 *
 * ■ サンプルサイズ
 * 対象race 12,271件 → predictRace成功・結果確定済み12,269件（結果未確定除外2、
 * scored<3除外0、DBエラー0）。163日（20260409〜20260918）、
 * train/test分割日20260726。ガールズ1,055件(8.6%) / 非ガールズ11,214件。
 * ◎的中率: ガールズ68.6% / 非ガールズ40.4%（ガールズの方が◎自体は当てやすい）。
 * ◎的中済み: ガールズn=724、非ガールズn=4,536。
 *
 * ■ Step1: 現行プールの「2着/3着が漏れる」実態 → 部分的に事実、ただし
 *   「ガールズが特に悪い」わけではなかった
 *   ガールズ（現行=totalScore順）: 2着・3着とも上位3プールに収まる率60.2%
 *     (train62.3%/test56.4%)。ランダム基準（プール幅3をランダムに選んだ場合の
 *     偶然一致率、6/(N×(N-1))の期待値）は20.9%。現行は基準の約2.9倍で、
 *     「totalScore順は無情報のノイズ」ではなく明確に機能している。
 *   非ガールズ（現行=buildLineAwarePool）: 49.2%(train49.2%/test49.2%、
 *     非常に安定)。ランダム基準20.3%（約2.4倍）。
 *   → 意外にも、ライン構造を使う非ガールズの方が素点順だけのガールズより
 *   プール内包率が低い（49.2%<60.2%）。「ラインが無いガールズの方が構造的に
 *   不利」という前提は支持されず、両者とも「プール幅3・非軸6〜8人」という
 *   組み合わせ論的制約から来る4割前後の機会損失を抱えている点はむしろ共通
 *   （scripts/diagnose-girls-margin-band.tsが確認した「プール幅を広げてもROIは
 *   悪化する」という結論とも整合し、幅の問題ではなく中身の問題）。
 *   とはいえ現行60.2%は改善の余地がないほど高くはなく、Step2に進む根拠は残る。
 *
 * ■ Step2【決定的】: ガールズの候補シグナル比較（◎的中n=724、
 *   heikin_tokuten/rentairitu2/3が非軸全員に揃っている共通母集団n=724/724）
 *     現行(totalScore)             : 全体60.2% train62.3% test56.4%
 *     heikin_tokuten（素点）        : 全体63.1% train66.0% test58.0% ← 3つとも現行超え
 *     lineupOrder(buildLineAwarePool流用): 全体52.1% train54.6% test47.5% → 現行以下
 *     rentairitu2(2連対率)          : 全体56.6% train60.8% test49.0% → 現行以下
 *     rentairitu3(3着内率)          : 全体60.8% train63.8% test55.3% → train微増/test微減で方向不一致
 *   → heikin_tokuten（総合スコアではなく素点そのもの）だけがtrain/testとも
 *   一貫して現行を上回った。totalScoreは脚質フィット・ライン加点等の
 *   ガールズには不要/ノイズになりうる補正込みだが、heikin_tokutenは
 *   これらの補正を経ない生の実力指標であり、「◎が決まった後、残りで
 *   純粋に地力が高い順」の方が2・3着当てには向くという解釈と整合する。
 *   lineupOrderScore（男子のライン内隊列予想向けにチューニング済み、
 *   standing_count/back_lead_count込み）はガールズにそのまま輸入すると
 *   明確に悪化し、男子向け調整をガールズに転用できないことも確認できた。
 *
 * ■ Step3（非ガールズ、副次確認）: 軸ラインメイトのペア(n≈4,700)でどちらが
 *   先着するかのconcordance
 *     現行(buildLineAwarePool経由のlineupOrderScore順): 全体72.5% train72.0% test73.4%
 *     heikin_tokuten: 全体72.7% train71.8% test74.4%（train微減・test微増で方向不一致、
 *       誤差の範囲）
 *     rentairitu2: 67.3% / rentairitu3: 65.1%（いずれも明確に現行以下）
 *   → 非ガールズのlineupOrderScoreは既にほぼ最良で、置き換える根拠は無い。
 *   このプロジェクトが繰り返し検証してきた「一度チューニング済みの合成信号を
 *   単純な生指標に置き換えても勝てない」パターンと一致。変更しない。
 *
 * ■ Step4【本採用の決め手】: 厳選(daily_picks) day-by-day選定シミュレーション
 *   （margin>=10・当日除外/9人立て除外/ABILITY_GAP_THIN_THRESHOLD除外を完全再現、
 *   ガールズのフォーメーションだけ候補シグナルで組み直し、非ガールズは現行のまま）
 *   全ピック母集団n=265（train179/test86）、うちガールズ抽出分n=59（train39/test20）。
 *
 *   baseline（現行）:
 *     全体　　: 回収率144.9%(train119.1%/test207.7%)
 *     ガールズ抽出分: 回収率83.7%(train89.5%/test72.4%) ← 両期間とも赤字、
 *       手動レビューの「ガールズだけ厳選が外れる」指摘と一致する実測結果
 *   候補: ガールズのみheikin_tokuten順に置換:
 *     全体　　: 回収率147.0%(train119.2%/test215.0%) ← 全体もどちらの期間も悪化なし
 *     ガールズ抽出分: 回収率95.1%(train90.0%/test105.0%) ← train微増(+0.5pt)・
 *       test大幅改善(+32.6pt、赤字→黒字転換)、全体+11.4pt
 *   候補: ガールズのみbuildLineAwarePool順に置換:
 *     全体139.5%(train113.8%/test201.9%)、ガールズ抽出分55.2%(train59.8%/test46.2%)
 *     → Step2の予測通り明確に悪化、不採用
 *   候補: ガールズのみrentairitu2順に置換:
 *     全体145.7%(train122.6%/test201.9%)、ガールズ抽出分87.8%
 *     (train109.3%/test45.9%) → train大幅改善・test大幅悪化で方向が逆転する
 *     典型的な過学習パターン、不採用
 *
 * ■ 結論: 採用
 * heikin_tokuten順は、Step2（プール内包率、train/testとも一貫して現行超え）と
 * Step4（実運用のday-by-day選定シミュレーション、全体・ガールズ抽出分ともtrain/test
 * で悪化なし、ガールズ抽出分はtestで赤字→黒字転換）の両方で一貫して現行を上回った
 * 唯一の候補であり、このプロジェクトの採用基準（train/test同方向、除外/変更対象
 * 単体の実利確認）を満たすためgenerateGirlsScenariosの2・3着プール並び順を
 * totalScore→heikin_tokuten（欠損時はtotalScoreにフォールバック）に変更した。
 * 軸(◎)選定自体（scored配列の並び、totalScore降順）は変更していない。
 * 非ガールズ側（buildLineAwarePool・lineupOrderScore）はStep3の通り変更なし。
 *
 * 残る留保点: (1) ガールズ抽出分のStep4母数はn=59（test側n=20）とやや薄く、
 * 個別レースのオッズに数字が引っ張られている余地がある。(2) train/test分割は
 * 1本のみ（分割日を変えたクロスチェックは未実施）。(3) heikin_tokutenと
 * totalScoreの相関が高い母集団（新人等でheikin_tokuten欠損）でのフォールバック
 * 挙動は今回のフルスキャンでは欠損0件のため実測できていない。
 * 実装後は他の厳選関連の変更と同様、daily_picksの実績推移を継続的に監視する。
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

const DAILY_PICKS_MIN_MARGIN = 10; // lib/repository.tsと同じ値（export済みだがここでは独立に固定値として複製）
const ABILITY_GAP_THIN_THRESHOLD = 5; // scripts/compute-picks.tsと同じ値の複製
const GIRLS_BUDGET = 10; // generateGirlsScenariosのbudget = floor(20/min(2,scored.length)) は scored.length>=2 で常に10

// formationFromPool (lib/scoring.ts、非export) の複製。
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
  lineAwarePool: number[]; // buildLineAwarePool順（非ガールズの現行プール、ガールズにも候補Bとして流用）
  totalScorePool: number[]; // 総合スコア降順（ガールズの現行プール）
  formation: string[]; // predictRaceが実際に出した「本命」シナリオの買い目（現行本番ロジック）
  actualCombo: string | null;
  hitOdds: number | null;
  abilityGap: number | null;
  closestKyakushitsu: string | null;
};

const CACHE_ARG_PREFIX = "--from-cache=";

async function main() {
  const fromCacheArg = process.argv.find((a) => a.startsWith(CACHE_ARG_PREFIX));
  let records: Rec[];

  if (fromCacheArg) {
    const cachePath = fromCacheArg.slice(CACHE_ARG_PREFIX.length);
    console.log(`キャッシュから読込: ${cachePath}`);
    records = JSON.parse(readFileSync(cachePath, "utf-8")) as Rec[];
    console.log(`読込完了: ${records.length}件`);
  } else {
    records = await scanAllRaces();
    const cacheOutArg = process.argv.find((a) => a.startsWith("--cache-out="));
    const cacheOutPath = cacheOutArg
      ? cacheOutArg.slice("--cache-out=".length)
      : path.join(process.cwd(), "scripts", "data", "second-third-signal-candidates-cache.json");
    writeFileSync(cacheOutPath, JSON.stringify(records));
    console.log(`候補データをキャッシュ保存: ${cacheOutPath}`);
  }

  runAnalysis(records);
  await closeDb();
}

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

        // abilityGap / closestKyakushitsu: scripts/compute-picks.ts の
        // ABILITY_GAP_THIN_THRESHOLD除外フィルタと全く同じロジックの複製（Step4の
        // baseline再現に使う）。
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

/** poolに対する actualSecondCar/actualThirdCar のランク(1始まり)とjoint-in-top3判定。 */
function rankStats(pool: number[], second: number, third: number) {
  const rank2 = pool.indexOf(second) + 1 || null;
  const rank3 = pool.indexOf(third) + 1 || null;
  const top3 = new Set(pool.slice(0, 3));
  const jointIn3 = top3.has(second) && top3.has(third);
  return { rank2, rank3, jointIn3 };
}

function randomBaselineJoint(n: number): number {
  // N人からランダムに3人選んだプールが、特定の2人(2着・3着)を両方含む確率 = 6/(N*(N-1))
  if (n < 3) return NaN;
  return 6 / (n * (n - 1));
}

function runAnalysis(records: Rec[]): void {
  const splitDate = splitDateOf(records);
  const dates = [...new Set(records.map((r) => r.date))].sort();
  console.log(
    `\n対象日数: ${dates.length}日（${dates[0]}〜${dates.at(-1)}） train/test分割日: ${splitDate}`
  );

  const girls = records.filter((r) => r.isGirls);
  const nonGirls = records.filter((r) => !r.isGirls);
  console.log(`\n全レース: ${records.length}件（ガールズ${girls.length}件 / 非ガールズ${nonGirls.length}件）`);
  console.log(
    `◎的中率（軸が実際に1着）: ガールズ${pct(girls.filter((r) => r.axisWon).length, girls.length)} / ` +
      `非ガールズ${pct(nonGirls.filter((r) => r.axisWon).length, nonGirls.length)}`
  );

  const girlsWon = girls.filter((r) => r.axisWon);
  const nonGirlsWon = nonGirls.filter((r) => r.axisWon);

  console.log("\n========== Step1: 現行プールの「2着/3着が漏れる」実態 ==========");

  function describePoolGroup(label: string, subset: Rec[], poolOf: (r: Rec) => number[]) {
    console.log(`\n--- ${label}（◎的中、n=${subset.length}） ---`);
    if (subset.length === 0) {
      console.log("  該当なし");
      return;
    }
    const rankHist = new Map<string, number>();
    let sumRank2 = 0;
    let rank2Count = 0;
    let joint = 0;
    let baselineSum = 0;
    for (const r of subset) {
      const pool = poolOf(r);
      const { rank2, rank3, jointIn3 } = rankStats(pool, r.actualSecondCar as number, r.actualThirdCar as number);
      const key = rank2 == null ? "不明" : rank2 >= 6 ? "6+" : String(rank2);
      rankHist.set(key, (rankHist.get(key) ?? 0) + 1);
      if (rank2 != null) {
        sumRank2 += rank2;
        rank2Count++;
      }
      if (jointIn3) joint++;
      baselineSum += randomBaselineJoint(r.nonAxis.length);
    }
    console.log(`  実際の2着のプール内順位分布: ${[...rankHist.entries()].sort().map(([k, v]) => `${k}位:${v}件`).join(" / ")}`);
    console.log(`  平均順位: ${(sumRank2 / rank2Count).toFixed(2)}`);
    console.log(
      `  現行プール(上位3)に2着・3着が両方収まる率（フォーメーション的中の必要条件）: ${pct(joint, subset.length)} (${joint}/${subset.length})`
    );
    console.log(`  ランダム基準（プール幅=3, フィールドサイズなりの偶然一致率の期待値）: ${((100 * baselineSum) / subset.length).toFixed(1)}%`);

    const train = subset.filter((r) => r.date < splitDate);
    const test = subset.filter((r) => r.date >= splitDate);
    const jointRate = (arr: Rec[]) => {
      let j = 0;
      for (const r of arr) {
        const pool = poolOf(r);
        if (rankStats(pool, r.actualSecondCar as number, r.actualThirdCar as number).jointIn3) j++;
      }
      return pct(j, arr.length);
    };
    console.log(`  train(n=${train.length}): ${jointRate(train)} / test(n=${test.length}): ${jointRate(test)}`);
  }

  describePoolGroup("ガールズ（現行=総合スコア順プール）", girlsWon, (r) => r.totalScorePool);
  describePoolGroup("非ガールズ（現行=buildLineAwarePool）", nonGirlsWon, (r) => r.lineAwarePool);

  console.log("\n========== Step2: ガールズの2着/3着プール順位替え候補比較 ==========");
  // 公平な比較のため、heikin_tokuten/rentairitu2/rentairitu3が非軸全員に揃っている
  // レースだけに限定した共通母集団で5候補を比較する。
  const girlsComplete = girlsWon.filter((r) =>
    r.nonAxis.every((e) => e.heikinTokuten != null && e.rentairitu2 != null && e.rentairitu3 != null)
  );
  console.log(
    `\n候補比較の共通母集団（◎的中・非軸全員のheikin_tokuten/rentairitu2/rentairitu3が揃っている）: n=${girlsComplete.length}/${girlsWon.length}`
  );

  type PoolBuilder = { label: string; build: (r: Rec) => number[] };
  function sortedPool(nonAxis: NonAxisEntry[], getter: (e: NonAxisEntry) => number | null): number[] {
    return [...nonAxis]
      .sort((a, b) => {
        const av = getter(a);
        const bv = getter(b);
        if (av == null && bv == null) return a.carNum - b.carNum;
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      })
      .map((e) => e.carNum);
  }
  const builders: PoolBuilder[] = [
    { label: "現行(totalScore)", build: (r) => r.totalScorePool },
    { label: "lineupOrder(buildLineAwarePool流用)", build: (r) => r.lineAwarePool },
    { label: "heikin_tokuten", build: (r) => sortedPool(r.nonAxis, (e) => e.heikinTokuten) },
    { label: "rentairitu2(2連対率)", build: (r) => sortedPool(r.nonAxis, (e) => e.rentairitu2) },
    { label: "rentairitu3(3着内率)", build: (r) => sortedPool(r.nonAxis, (e) => e.rentairitu3) },
  ];

  function evalBuilders(subset: Rec[], heading: string) {
    console.log(`\n--- ${heading}（n=${subset.length}） ---`);
    if (subset.length === 0) {
      console.log("  該当なし");
      return;
    }
    const train = subset.filter((r) => r.date < splitDate);
    const test = subset.filter((r) => r.date >= splitDate);
    for (const b of builders) {
      const jointRate = (arr: Rec[]) => {
        let j = 0;
        for (const r of arr) {
          const pool = b.build(r);
          if (rankStats(pool, r.actualSecondCar as number, r.actualThirdCar as number).jointIn3) j++;
        }
        return { pct: pct(j, arr.length), n: j };
      };
      const all = jointRate(subset);
      const tr = jointRate(train);
      const te = jointRate(test);
      console.log(
        `  ${b.label.padEnd(28, "　")}: 全体${all.pct}(${all.n}/${subset.length}) train${tr.pct}(${tr.n}/${train.length}) test${te.pct}(${te.n}/${test.length})`
      );
    }
  }

  evalBuilders(girlsComplete, "ガールズ候補比較（プール内包率、共通母集団）");

  console.log("\n========== Step3: 非ガールズ・同ラインの2着/3着並び替え候補比較（参考） ==========");
  // 軸のラインメイト同士のペアで、どちらが先に入線するかを各シグナルがどれだけ
  // 正しく言い当てるか（concordance）を見る。lineupOrderScoreは非exportのため、
  // buildLineAwarePoolの並び順（同ライン内はlineupOrderScore降順）をそのまま使う。
  type PairSignal = { label: string; predictsAheadIsA: (a: NonAxisEntry, b: NonAxisEntry, lineAwarePool: number[]) => boolean | null };
  const pairSignals: PairSignal[] = [
    {
      label: "現行(lineupOrderScore経由のbuildLineAwarePool順)",
      predictsAheadIsA: (a, b, pool) => {
        const ia = pool.indexOf(a.carNum);
        const ib = pool.indexOf(b.carNum);
        if (ia === -1 || ib === -1 || ia === ib) return null;
        return ia < ib;
      },
    },
    {
      label: "heikin_tokuten",
      predictsAheadIsA: (a, b) =>
        a.heikinTokuten == null || b.heikinTokuten == null || a.heikinTokuten === b.heikinTokuten
          ? null
          : a.heikinTokuten > b.heikinTokuten,
    },
    {
      label: "rentairitu2",
      predictsAheadIsA: (a, b) =>
        a.rentairitu2 == null || b.rentairitu2 == null || a.rentairitu2 === b.rentairitu2
          ? null
          : a.rentairitu2 > b.rentairitu2,
    },
    {
      label: "rentairitu3",
      predictsAheadIsA: (a, b) =>
        a.rentairitu3 == null || b.rentairitu3 == null || a.rentairitu3 === b.rentairitu3
          ? null
          : a.rentairitu3 > b.rentairitu3,
    },
  ];

  type Pair = { date: string; a: NonAxisEntry; b: NonAxisEntry; aAhead: boolean; lineAwarePool: number[] };
  const pairs: Pair[] = [];
  for (const r of nonGirlsWon) {
    const mates = r.nonAxis.filter((e) => e.lineGroup != null && e.lineGroup === r.axisLineGroup);
    for (let i = 0; i < mates.length; i++) {
      for (let j = i + 1; j < mates.length; j++) {
        const a = mates[i];
        const b = mates[j];
        const fa = r.finishPosByCar[a.carNum];
        const fb = r.finishPosByCar[b.carNum];
        if (fa == null || fb == null || fa === fb) continue;
        pairs.push({ date: r.date, a, b, aAhead: fa < fb, lineAwarePool: r.lineAwarePool });
      }
    }
  }
  console.log(`\n軸ラインメイトのペア数（着順比較可能）: ${pairs.length}件`);
  const pairsTrain = pairs.filter((p) => p.date < splitDate);
  const pairsTest = pairs.filter((p) => p.date >= splitDate);
  for (const sig of pairSignals) {
    const acc = (arr: Pair[]) => {
      let correct = 0;
      let total = 0;
      for (const p of arr) {
        const pred = sig.predictsAheadIsA(p.a, p.b, p.lineAwarePool);
        if (pred == null) continue;
        total++;
        if (pred === p.aAhead) correct++;
      }
      return { pct: pct(correct, total), n: total };
    };
    const all = acc(pairs);
    const tr = acc(pairsTrain);
    const te = acc(pairsTest);
    console.log(
      `  ${sig.label.padEnd(32, "　")}: 全体${all.pct}(n=${all.n}) train${tr.pct}(n=${tr.n}) test${te.pct}(n=${te.n})`
    );
  }

  console.log("\n========== Step4: 厳選(daily_picks) day-by-day選定シミュレーション ==========");
  runStep4Simulation(records, splitDate);
}

// ---- Step4: 実際のgetDailyPicks選定を再現し、ガールズのフォーメーションだけを
// 候補シグナルで組み直した場合に回収率がどう変わるかを検証する。
function runStep4Simulation(records: Rec[], splitDate: string): void {
  function sortedPool(nonAxis: NonAxisEntry[], getter: (e: NonAxisEntry) => number | null): number[] {
    return [...nonAxis]
      .sort((a, b) => {
        const av = getter(a);
        const bv = getter(b);
        if (av == null && bv == null) return a.carNum - b.carNum;
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      })
      .map((e) => e.carNum);
  }

  type Variant = { label: string; formationFor: (r: Rec) => string[] };
  const variants: Variant[] = [
    { label: "baseline(現行のformationそのまま)", formationFor: (r) => r.formation },
    {
      label: "候補: ガールズのみlineAwarePool順に置換",
      formationFor: (r) =>
        r.isGirls ? formationFromPool(r.axisCarNum, r.lineAwarePool, GIRLS_BUDGET) : r.formation,
    },
    {
      label: "候補: ガールズのみheikin_tokuten順に置換",
      formationFor: (r) =>
        r.isGirls
          ? formationFromPool(r.axisCarNum, sortedPool(r.nonAxis, (e) => e.heikinTokuten), GIRLS_BUDGET)
          : r.formation,
    },
    {
      label: "候補: ガールズのみrentairitu2順に置換",
      formationFor: (r) =>
        r.isGirls
          ? formationFromPool(r.axisCarNum, sortedPool(r.nonAxis, (e) => e.rentairitu2), GIRLS_BUDGET)
          : r.formation,
    },
  ];

  function isEligible(r: Rec): boolean {
    if (r.stage === "予選") return false;
    if (r.fieldSize === 9) return false;
    if (r.margin < DAILY_PICKS_MIN_MARGIN) return false;
    if (r.abilityGap != null && r.abilityGap < ABILITY_GAP_THIN_THRESHOLD) {
      if (r.closestKyakushitsu === "逃" || r.closestKyakushitsu === "両") return false;
    }
    return true;
  }

  type SimResult = { races: number; hits: number; stake: number; payout: number; picks: number; days: number };
  function simulate(variant: Variant, dateFilter: (d: string) => boolean, girlsOnly: boolean): SimResult {
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
  function fmt(s: SimResult): string {
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
