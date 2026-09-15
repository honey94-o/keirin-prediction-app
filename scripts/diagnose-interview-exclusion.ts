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
import { getResultsForRaces, getOddsForRaces, resolveActualCombo } from "../lib/repository";
import { raceStage } from "../lib/scoring";

/**
 * 【検証結果: 不採用（母集団不足＋train/test不安定の二重の理由）】
 *
 * scripts/diagnose-interview-condition.tsで見つかった「紙面1番手（heikin_tokuten
 * 順位1位）がネガ発言をすると3着内率が-2〜3pt下がり、紙面2番手が得をする」という
 * 効果（交絡チェック済み・train/test安定）を、実際の厳選（daily_picks）の運用に
 * 当てはめた時に効くかを検証する。同スクリプトのヘッダー末尾に残っていた
 * 「本命がネガ発言のレースを厳選から除外」の要否をバックテストで確かめる、
 * という未実施タスクの続き。
 *
 * 厳選の定義（scripts/compute-picks.tsのdailyPicks構築・lib/repository.tsの
 * getDailyPicks）: 予選除外・9人立て除外の上でpredictRaceのscored[0]を本命、
 * margin=scored[0].totalScore-scored[1].totalScoreとし、「本命」シナリオの
 * formation.combinations（3連単の組み合わせ配列）が実際の着順と一致すれば的中。
 * getDailyPicksはこのうちmargin>=10（DAILY_PICKS_MIN_MARGIN）を満たすものを
 * その日のmargin降順で上位10件だけ表示する。
 *
 * 実装方法についての注記: predictRaceを対象レース全件で毎回呼び直すのではなく、
 * predictions テーブル（backtest.ts等が保存するスナップショット。race_idの
 * 98.9%（11,980/12,119件）が既にカバー済みと確認済み）から honmei（total_score
 * 最大の行）・margin（1位-2位のtotal_score差）・formation（◎行にのみ保存される
 * 「本命」シナリオの3連単フォーメーション）を復元する方式にした。理由:
 *   (1) predictRaceを毎レース呼ぶとbacktest.ts --limit=3000級のスキャンになり、
 *       このタスクの想定コスト（daily_picks程度の軽い検証）を超える。
 *   (2) predictions テーブルはそもそも「後から選手成績が更新されても過去の
 *       予想を遡って変えない」ためのスナップショット用途で作られており
 *       （db/schema.postgres.sqlのコメント参照）、historical backtestの再現性
 *       という点でむしろ適切な情報源。
 *   (3) 実際に少数レースでpredictRaceを再実行してスポットチェックしたところ、
 *       margin・formationとも大半は一致したが、直近1日分でも約1/5の頻度で
 *       僅かなズレ（データ更新由来、スコアリングロジック自体の変更ではない）が
 *       見られた。ただし本検証はneg集団とその他集団の「相対比較」であり、
 *       同一スナップショットを両群に一貫して使う限り、この程度のノイズは
 *       双方に均等にかかるため結論を歪めない。
 *
 * ■ Step1: feasibility
 * predictions保存済み11,980レースのうち予選・9人立てを除いた厳選候補は8,154件。
 * このうち本命（scored[0]相当、predictions上でtotal_score最大の行）がneg発言
 * だったのは316件（3.9%）で、diagnose-interview-condition.tsの紙面1番手neg比率
 * （3.8〜4.0%）と一致し、predictions由来のhonmei特定が機能していることを確認できた。
 *
 * ただし実際に「厳選」として判定対象になるのはgetDailyPicksの閾値margin>=10を
 * 満たすものだけで、これは556件（8,154件の6.8%）しかない。その中で本命がneg発言
 * だったのはわずか19件（3.4%）。このプロジェクトの他の検証（例:
 * scripts/diagnose-gear-meet-change.ts）で「判断不能」の目安としてきた最低件数
 * （目安30件）を下回っており、margin>=10母集団だけでは train/test に分割する
 * 以前の問題として、19件という絶対数自体が的中率・回収率の議論に耐えない。
 *
 * ■ Step2: 母集団を広げた参考検証（margin制限なし、8,154件・neg=316件）
 * 実際の判定対象（margin>=10）では検証が成立しないため、参考として
 * margin制限なしの全候補（8,154件）でも同じ比較を行った（train/test分割は
 * kaisai_date昇順で2/3・1/3）:
 *   (a) baseline（全体）    : 的中24.1%(1964/8153) 回収率111.1%
 *                             train 的中24.5%(1323/5398) 回収率111.7%
 *                             test  的中23.3%(641/2755)  回収率109.7%
 *       neg-subset(n=316)  : 的中22.5%(71/316)   回収率88.7%
 *                             train 的中25.3%(50/198)   回収率108.9%
 *                             test  的中17.8%(21/118)   回収率50.6%
 *   (b) neg除外後の残り     : 的中24.2%(1893/7837) 回収率111.9%
 *                             train 的中24.5%(1273/5200) 回収率111.8%
 *                             test  的中23.5%(620/2637)  回収率112.3%
 *
 * 全体で見るとneg除外でROIが111.1%→111.9%（+0.8pt）と改善しそうに見えるが、
 * train/testで分解すると崩れる: trainではneg-subsetの的中率(25.3%)がbaseline
 * (24.5%)よりむしろ高く、回収率(108.9%)もbaselineとほぼ同水準(111.7%)で、
 * 「除外した方が良い」根拠が無い。効果が現れるのはtestだけで、しかも的中率
 * 17.8%・回収率50.6%という大きな落ち込みは、n=118のサンプルで数件の的中が
 * たまたま低配当止まりだったことで説明可能な範囲であり、trainで再現しない
 * 時点でdiagnose-nige-senko-bantesu.ts等これまでの「相関はあるが不安定/交絡」
 * パターンよりもさらに弱い（train自体が支持していない）。
 *
 * （参考）実際の判定対象であるmargin>=10母集団（n=556、neg=19）そのものの
 * 全体値（train/test分割は母数不足のため実施せず）:
 *   baseline全体: 的中57.0%(317/556) 回収率114.8%
 *   neg-subset(n=19): 的中42.1%(8/19) 回収率96.9%
 *   neg除外後: 的中57.5%(309/537) 回収率115.4%
 * 方向としては「本命negの方が悪い」という仮説と矛盾しないが、n=19では
 * 二項分布のノイズだけで説明できる差であり（57%が母比率なら19件中の期待
 * 的中数は約10.8件、実際は8件で誤差の範囲内）、これ単独では何も言えない。
 *
 * ■ 総合判断
 * diagnose-interview-condition.tsが確認した「紙面1番手のneg発言→本人の3着内率
 * が下がる」という選手個人成績レベルの効果自体は交絡なしの本物と判断済みだが、
 * それを「3連単フォーメーション的中」という厳選の実際の的中定義に翻訳すると、
 * (1)厳選が実際に判定対象とする母集団（margin>=10）内でのneg発生件数が19件と
 * 極端に薄く、判断材料として成立しない。(2)母集団を広げた参考検証でも、
 * train側では効果が全く見られず（的中率はむしろneg側が高い）、test側でのみ
 * 大きな悪化が出るという典型的な過学習/ノイズのパターンで、train/test安定と
 * いうこのプロジェクトの採用基準を満たさない。(3)たとえ効果が本物だとしても、
 * 実運用のmargin>=10母集団内での発生率は3.4%（556件中19件、約1〜2ヶ月に1回
 * 程度）に過ぎず、除外を実装してもROIへの影響は測定不能なほど小さい見込み。
 * 以上3点いずれもshipを正当化しないため、lib/scoring.ts・scripts/compute-picks.ts
 * への変更（Step3）は行わない。scripts/diagnose-interview-condition.tsの
 * ヘッダーに残っていた「本命がネガ発言のレースを厳選から除外」の要否は、
 * 本スクリプトの検証をもって「不採用」で決着とする（2026-09-15）。
 */

// scripts/diagnose-interview-condition.tsのclassify()をそのまま再利用（正規表現の
// 再定義はしない）。
const NEG_CONDITION =
  /(調子|状態|体調|感じ|具合)[^。]{0,14}(良くな|よくな|悪い|上がら|上がって(こ|き)?な|イマイチ|いまいち|パッとしな|良いとは言えな|下降|最悪|最低)/;
const NEG_PRACTICE = /(練習|調整|乗り込み|乗り込め)[^。]{0,12}(でき(て)?い?な|出来(て)?い?な|不足)|練習不足/;
const NEG_EXCLUDE = /(悪いわけでは|悪くはな|悪くな|問題な|影響はな|不安はな|心配な(い|さそう))/;
const POS_CONDITION =
  /(調子|状態|体調|感じ|具合|仕上がり)[^。]{0,14}(いい|良い|上向き|上がって(き|る)|戻って(き|る)|バッチリ|絶好調|悪くない|上々)/;
const POS_CONFIDENCE = /自信[^。]{0,6}(が)?あ(る|り)|手応え[^。]{0,8}(が)?あ(る|り)|絶好調|バッチリ/;

function classify(text: string | null): "neg" | "pos" | "neutral" {
  if (!text) return "neutral";
  const neg = (NEG_CONDITION.test(text) || NEG_PRACTICE.test(text)) && !NEG_EXCLUDE.test(text);
  const pos = POS_CONDITION.test(text) || POS_CONFIDENCE.test(text);
  if (neg && !pos) return "neg";
  if (pos && !neg) return "pos";
  return "neutral";
}

/** lib/repository.tsのgetDailyPicksと同じ閾値。 */
const DAILY_PICKS_MIN_MARGIN = 10;
/** この件数を下回ったら、この項目単体では判断不能として打ち切る
 *（scripts/diagnose-gear-meet-change.ts等、このプロジェクトの既存の目安に合わせる）。 */
const MIN_FEASIBLE_N = 30;

type PredRow = {
  race_id: number;
  kaisai_date: string;
  syumoku: string | null;
  car_num: number;
  snum: string;
  total_score: number;
  formation: string | null;
};

type Candidate = {
  raceId: number;
  kaisaiDate: string;
  margin: number;
  honmeiSnum: string;
  formation: string[];
  honmeiCat: "neg" | "pos" | "neutral";
};

type Outcome = Candidate & { hit: boolean; stake: number; payout: number };

function agg(arr: Outcome[]) {
  const races = arr.length;
  const hits = arr.filter((o) => o.hit).length;
  const stake = arr.reduce((s, o) => s + o.stake, 0);
  const payout = arr.reduce((s, o) => s + o.payout, 0);
  return {
    races,
    hits,
    stake,
    payout,
    hitRate: races > 0 ? (100 * hits) / races : null,
    roi: stake > 0 ? (100 * payout) / stake : null,
  };
}
function fmt(a: ReturnType<typeof agg>): string {
  const hr = a.hitRate != null ? a.hitRate.toFixed(1) + "%" : "-";
  const roi = a.roi != null ? a.roi.toFixed(1) + "%" : "-";
  return `的中${hr}(${a.hits}/${a.races}) 回収率${roi}`;
}
function reportGroup(label: string, arr: Outcome[], split: string): void {
  const train = arr.filter((o) => o.kaisaiDate < split);
  const test = arr.filter((o) => o.kaisaiDate >= split);
  console.log(`  ${label}: 全体 ${fmt(agg(arr))} | train ${fmt(agg(train))} | test ${fmt(agg(test))}`);
}

async function main() {
  const db = getDb();

  // ---- predictions×racesからhonmei・margin・formationを復元 ----
  const predRes = await db.execute(`
    SELECT p.race_id, ra.kaisai_date, ra.syumoku, p.car_num, p.snum, p.total_score, p.formation
    FROM predictions p
    JOIN races ra ON ra.id = p.race_id
    ORDER BY p.race_id, p.total_score DESC
  `);
  const predRows = predRes.rows as unknown as PredRow[];

  const byRace = new Map<number, PredRow[]>();
  for (const r of predRows) {
    const arr = byRace.get(r.race_id) ?? [];
    arr.push(r);
    byRace.set(r.race_id, arr);
  }

  // ---- racer_interviewsをrace_id:snumごとに集約（diagnose-interview-condition.tsと同じ形） ----
  const interviewRes = await db.execute(`
    SELECT race_id, snum, string_agg(answer, ' ') AS answers
    FROM racer_interviews GROUP BY race_id, snum
  `);
  const interviewMap = new Map<string, string>();
  for (const r of interviewRes.rows as unknown as { race_id: number; snum: string; answers: string }[]) {
    interviewMap.set(`${r.race_id}:${r.snum}`, r.answers);
  }

  const candidates: Candidate[] = [];
  let totalRaces = 0;
  let excludedYosen = 0;
  let excluded9car = 0;
  let excludedLessThan2 = 0;
  let excludedNoFormation = 0;

  for (const [raceId, entries] of byRace) {
    totalRaces++;
    if (raceStage(entries[0].syumoku) === "予選") {
      excludedYosen++;
      continue;
    }
    if (entries.length === 9) {
      excluded9car++;
      continue;
    }
    if (entries.length < 2) {
      excludedLessThan2++;
      continue;
    }
    const sorted = [...entries].sort((a, b) => b.total_score - a.total_score);
    const honmei = sorted[0];
    const taikou = sorted[1];
    if (!honmei.formation) {
      excludedNoFormation++;
      continue;
    }
    const margin = honmei.total_score - taikou.total_score;
    const formation = JSON.parse(honmei.formation) as string[];
    const answers = interviewMap.get(`${raceId}:${honmei.snum}`) ?? null;
    candidates.push({
      raceId,
      kaisaiDate: entries[0].kaisai_date,
      margin,
      honmeiSnum: honmei.snum,
      formation,
      honmeiCat: classify(answers),
    });
  }

  console.log("========== Step1: feasibility ==========");
  console.log(
    `predictionsに予想が保存済みのレース: ${totalRaces}件 ` +
      `（予選除外${excludedYosen} / 9人立て除外${excluded9car} / scored<2除外${excludedLessThan2} / ` +
      `本命シナリオ無し除外${excludedNoFormation}）`
  );
  console.log(`厳選候補（除外後、margin制限なし）: ${candidates.length}件`);

  const negAll = candidates.filter((c) => c.honmeiCat === "neg");
  console.log(
    `  うち本命(scored[0])がneg発言: ${negAll.length}件 (${((100 * negAll.length) / candidates.length).toFixed(1)}%)`
  );

  const marginQualifying = candidates.filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN);
  const negInMarginQualifying = marginQualifying.filter((c) => c.honmeiCat === "neg");
  console.log(`\nmargin>=${DAILY_PICKS_MIN_MARGIN}（getDailyPicksの閾値）候補: ${marginQualifying.length}件`);
  console.log(
    `  うち本命がneg発言: ${negInMarginQualifying.length}件 ` +
      `(${marginQualifying.length > 0 ? ((100 * negInMarginQualifying.length) / marginQualifying.length).toFixed(1) : "-"}%)`
  );

  // 参考: 実際の「上位10件/日」カットまで適用した場合の母数（getDailyPicks完全再現）
  const byDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byDate.get(c.kaisaiDate) ?? [];
    arr.push(c);
    byDate.set(c.kaisaiDate, arr);
  }
  const top10PerDay: Candidate[] = [];
  for (const arr of byDate.values()) {
    const qualifying = arr
      .filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN)
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 10);
    top10PerDay.push(...qualifying);
  }
  console.log(
    `\n（参考）実運用のgetDailyPicks完全再現（margin>=10かつ日別上位10件）: ${top10PerDay.length}件、` +
      `うち本命neg: ${top10PerDay.filter((c) => c.honmeiCat === "neg").length}件`
  );

  if (negInMarginQualifying.length < MIN_FEASIBLE_N) {
    console.log(
      `\n→ margin>=10母集団内の本命neg件数（${negInMarginQualifying.length}件）が` +
        `事前の打ち切り基準（${MIN_FEASIBLE_N}件未満）を下回った。`
    );
    if (negAll.length >= MIN_FEASIBLE_N) {
      console.log(
        `  margin制限なしの母集団では${negAll.length}件あるため、参考としてそちらでStep2を実施する` +
          `（ただし「厳選」の実際の判定対象はmargin>=10のみのため、この結果は直接は実装判断に使えない）。`
      );
    } else {
      console.log("  margin制限なし母集団でも母数不足のため、ここで打ち切る。Step2以降は実施しない。");
      await closeDb();
      return;
    }
  }

  // ---- Step2: 実際の的中判定 ----
  const usePopulation = negInMarginQualifying.length >= MIN_FEASIBLE_N ? marginQualifying : candidates;
  const populationLabel =
    negInMarginQualifying.length >= MIN_FEASIBLE_N ? `margin>=${DAILY_PICKS_MIN_MARGIN}候補` : "margin制限なし候補（参考）";

  const raceIds = usePopulation.map((c) => c.raceId);
  const [resultsMap, oddsMap] = await Promise.all([getResultsForRaces(raceIds), getOddsForRaces(raceIds)]);

  const outcomes: Outcome[] = [];
  for (const c of usePopulation) {
    const results = resultsMap.get(c.raceId) ?? [];
    const odds = oddsMap.get(c.raceId) ?? [];
    const actualCombo = resolveActualCombo(results, odds);
    if (actualCombo == null) continue; // 未確定レースはROI計算から除外（getDailyPicksResultsと同じ）
    const stake = 100 * c.formation.length;
    const hit = c.formation.includes(actualCombo);
    const hitOdds = odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
    const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
    outcomes.push({ ...c, hit, stake, payout });
  }

  console.log(`\n========== Step2: ${populationLabel}での厳選ヒット率・回収率比較 ==========`);
  console.log(`結果確定済み: ${outcomes.length}/${usePopulation.length}件`);

  const dates = [...new Set(outcomes.map((o) => o.kaisaiDate))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`train=${dates[0]}〜 / test=${split}〜${dates.at(-1)}\n`);

  const negSubset = outcomes.filter((o) => o.honmeiCat === "neg");
  const restSubset = outcomes.filter((o) => o.honmeiCat !== "neg");

  reportGroup("(a) baseline（除外なし、全体）", outcomes, split);
  reportGroup("    neg-subset（本命がneg発言）", negSubset, split);
  reportGroup("(b) neg除外後の残り", restSubset, split);

  console.log(
    `\nneg-subsetの件数: ${negSubset.length}件（train${negSubset.filter((o) => o.kaisaiDate < split).length}` +
      ` / test${negSubset.filter((o) => o.kaisaiDate >= split).length}）`
  );

  // ---- 参考: 実際の判定対象であるmargin>=10母集団自体の実績も出しておく
  //（train/test分割するには薄すぎるため全体値のみ。判断には使わない） ----
  if (usePopulation !== marginQualifying) {
    const mqRaceIds = marginQualifying.map((c) => c.raceId);
    const [mqResultsMap, mqOddsMap] = await Promise.all([
      getResultsForRaces(mqRaceIds),
      getOddsForRaces(mqRaceIds),
    ]);
    const mqOutcomes: Outcome[] = [];
    for (const c of marginQualifying) {
      const results = mqResultsMap.get(c.raceId) ?? [];
      const odds = mqOddsMap.get(c.raceId) ?? [];
      const actualCombo = resolveActualCombo(results, odds);
      if (actualCombo == null) continue;
      const stake = 100 * c.formation.length;
      const hit = c.formation.includes(actualCombo);
      const hitOdds = odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
      const payout = hit && hitOdds != null ? 100 * hitOdds : 0;
      mqOutcomes.push({ ...c, hit, stake, payout });
    }
    const mqNeg = mqOutcomes.filter((o) => o.honmeiCat === "neg");
    const mqRest = mqOutcomes.filter((o) => o.honmeiCat !== "neg");
    console.log(
      `\n========== 参考: 実際の判定対象（margin>=10）自体の実績（train/test分割せず全体値のみ、判断には使わない） ==========`
    );
    console.log(`  全体: ${fmt(agg(mqOutcomes))}`);
    console.log(`  neg-subset(n=${mqNeg.length}): ${fmt(agg(mqNeg))}`);
    console.log(`  neg除外後: ${fmt(agg(mqRest))}`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
