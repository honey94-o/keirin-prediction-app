import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb, closeDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";

/**
 * 【検証結果: 不採用（ガールズは狭めるほど回収率が悪化。train/testとも現行の6点が最良）】
 *
 * 2026-09-11に導入したhonmeiFormationHighMargin（通常レース、margin>=10で本命の
 * フォーメーションを20点→2〜12点に絞る。lib/scoring.ts L1140、絞った根拠は
 * L1117-1129のコメント参照）と同じ発想が、generateGirlsScenarios（ガールズケイリン
 * 専用、ラインが無いため本命=総合1位/対抗=総合2位の2パターンのみ）にも
 * 当てはまるかを検証した。generateGirlsScenariosは本命の点数を
 * `formationFromPool(axis, pool, Math.floor(20/2)=10)`で決めており、
 * pool.length>=4（=出走6人以上）なら常にpoolSize=3・6点のフォーメーションに
 * なる（3*2=6<=10だが4*3=12>10のため）。marginが19.1のような極端な
 * レースでも同じ6点になっており、通常レースのhonmeiFormationHighMargin導入前
 * （33日で-12.6万円）と同じ構図に見えたため検証した。
 *
 * ■ 方法
 * predictRace（lib/predict.ts）をL級混在レース全件（`EXISTS (... rc.class_rank
 * LIKE 'L%')`、backtest.tsの--girls-onlyと同じ条件）に対して実行し、
 * isGirlsRaceと同じ判定（scored.some(class_rank startsWith "L")）で二重確認。
 * margin = scored[0].totalScore - scored[1].totalScore。的中判定・払戻オッズは
 * backtest.tsのprocessRace（L64-122）と同じロジック（3連単オッズの組み合わせが
 * 1種類だけの時のみ公式着順として採用、複数通りある古いデータはresults.finish_pos
 * から組み立て）を複製。train/testは開催日で2/3・1/3にクロノロジカル分割。
 *
 * ■ サンプルサイズ（結果確定済み・predictRace成功: 1022件、スキップ0件）
 *   margin<5   : 504件(49.3%)   margin5-8 : 196件(19.2%)   margin8-10: 107件(10.5%)
 *   margin10-13: 99件(9.7%)     margin13-16: 69件(6.8%)    margin16+ : 47件(4.6%)
 *   → margin>=10: 215件 / margin>=13: 116件（train/test分割日20260723、
 *      margin>=10のtrain130件・test85件、margin>=13のtrain75件・test41件）。
 *   出走頭数はほぼ固定（7人が946件=92.6%、6人66件、5人10件）で、pool（軸を除く
 *   残り）が常に6前後のため、現行budget=10は常にpoolSize=3・6点で頭打ちになる
 *   （ユーザー指摘の「margin19.1でも6点になる」を再現・確認）。
 *   母数自体（n=215/116）は薄いが、この規模での比較検討自体は打ち切るほど
 *   小さくはないと判断し、Step2（候補比較）に進んだ。
 *
 * ■ 候補と結果（賭け金100円/点、回収率=払戻/賭け金）
 * 現行「対称2点(budget2)」「非対称tight2点」（honmeiFormationHighMarginの
 * margin>=13枝＝◎→pool[0]固定→pool[1],pool[2]の2点、と同じ形）を比較。
 *
 *   margin>=10（n=215）:
 *     現行6点   : 全体91.2% train104.0% test71.5%
 *     対称2点   : 全体83.3% train 98.5% test60.1%
 *     tight2点  : 全体64.2% train 72.3% test51.8%
 *   margin10-13（n=99）:
 *     現行6点   : 全体83.2% train 99.2% test63.3%
 *     対称2点   : 全体66.5% train 70.3% test61.8%
 *     tight2点  : 全体56.6% train 65.4% test45.6%
 *   margin>=13（n=116）:
 *     現行6点   : 全体97.9% train107.5% test80.4%
 *     対称2点   : 全体97.7% train119.2% test58.3%（trainだけ現行超え→testで逆転）
 *     tight2点  : 全体70.7% train 77.4% test58.4%
 *
 * ■ 判断
 * 通常レースとは逆に、ガールズは狭めるほど一貫して回収率が悪化した。
 * 現行の6点は3つの帯すべて・train/testの両方で両候補を上回り、崩れなかった
 * （唯一train側で現行を上回った「margin>=13の対称2点」もtestで58.3%まで
 * 落ちて現行の80.4%を大きく下回り、train/testで方向が逆転＝過学習の典型
 * パターンで、このリポジトリの他の検証（diagnose-nige-senko-bantesu.ts等）
 * と同じ基準で不採用対象）。
 * 原因の解釈：通常レースのhonmeiFormationHighMarginは「同じライン」という
 * 強い構造的情報でpoolを絞ってから点数を減らすため、絞っても2着的中を
 * さほど落とさずに済む。一方ガールズはラインが無く、poolは単なる総合スコア
 * 順（isGirlsRaceのコメント通りライン前提のロジックが使えない）なので、
 * 上位2頭に絞ると通常レースほど「絞っても当たる」が成立せず、的中率が
 * ほぼ半減する分だけ回収率も素直に悪化する。本命が抜けている（margin大）
 * ことと「2着・3着が上位2頭に収まりやすい」ことは、ライン構造がない
 * ガールズでは別の話だったということ。
 * → generateGirlsScenariosへの変更は行わない（現状維持）。honmeiFormationHighMargin
 * のようなmargin帯別の絞り込みルールをガールズに輸入する根拠はない。
 * lib/scoring.tsへの変更・backtest.ts --girls-onlyでの前後比較は実施していない
 * （Step2の時点で明確に不採用と判断できたため）。
 */

// generateGirlsScenarios / formationFromPool (lib/scoring.ts、非export) の複製。
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

// honmeiFormationHighMargin (lib/scoring.ts、非export) のmargin>=13枝の複製（2点固定）。
function tight2(axis: number, pool: number[]): string[] {
  const second = pool[0];
  if (second == null) return [];
  return pool
    .slice(1, 3)
    .filter((third) => third !== second)
    .map((third) => `${axis}-${second}-${third}`);
}

type Rec = {
  raceId: number;
  date: string;
  margin: number;
  fieldSize: number;
  axisCarNum: number;
  pool: number[];
  actualCombo: string;
  hitOdds: number | null;
};

async function main() {
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT DISTINCT ra.id, ra.kaisai_date FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos IS NOT NULL
    WHERE EXISTS (
      SELECT 1 FROM entries e JOIN racers rc ON rc.snum = e.snum
      WHERE e.race_id = ra.id AND rc.class_rank LIKE 'L%'
    )
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string }[];
  console.log(`ガールズ（L級混在）レース候補: ${races.length}件`);

  const records: Rec[] = [];
  let notGirlsByScoredCheck = 0;
  let skippedNoScore = 0;
  let skippedNoResult = 0;

  const CONCURRENCY = 8;
  for (let i = 0; i < races.length; i += CONCURRENCY) {
    const chunk = races.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (race): Promise<Rec | null> => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 3) {
          skippedNoScore++;
          return null;
        }
        const { scored } = prediction;
        // isGirlsRaceと全く同じ判定条件（class_rankがLで始まる選手が1人でもいる）で
        // 二重チェックする（クエリ側のJOIN条件と食い違いがないことの確認も兼ねる）。
        if (!scored.some((s) => s.entry.class_rank?.startsWith("L"))) {
          notGirlsByScoredCheck++;
          return null;
        }

        const honmei = scored[0];
        const taikou = scored[1];
        const margin = honmei.totalScore - taikou.totalScore;

        const raceResults = await getResultsForRace(race.id);
        const top3 = raceResults
          .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
          .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
        if (top3.length < 3) {
          skippedNoResult++;
          return null;
        }

        const odds = (await getOddsForRace(race.id)).filter((o) => o.bet_type === "3連単");
        const distinctCombos = new Set(odds.map((o) => o.combination));
        const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
        const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");
        const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

        // generateGirlsScenariosのbuildFor(0,...)と同じpool（軸を除き総合スコア降順）
        const pool = scored
          .filter((s) => s.entry.car_num !== honmei.entry.car_num)
          .sort((a, b) => b.totalScore - a.totalScore)
          .map((s) => s.entry.car_num);

        return {
          raceId: race.id,
          date: race.kaisai_date,
          margin,
          fieldSize: scored.length,
          axisCarNum: honmei.entry.car_num,
          pool,
          actualCombo,
          hitOdds,
        };
      })
    );
    for (const o of outcomes) if (o) records.push(o);
    if ((i / CONCURRENCY) % 20 === 0) {
      console.log(`  進捗 ${Math.min(i + CONCURRENCY, races.length)}/${races.length}`);
    }
  }

  console.log(`\npredictRace成功・結果確定済み: ${records.length}件`);
  console.log(`  スキップ(scored<3等): ${skippedNoScore}件 / L判定不一致: ${notGirlsByScoredCheck}件 / 結果不完全: ${skippedNoResult}件`);

  // ---- margin分布 ----
  console.log("\n=== marginの分布 ===");
  const bands: [string, (m: number) => boolean][] = [
    ["<5", (m) => m < 5],
    ["5-8", (m) => m >= 5 && m < 8],
    ["8-10", (m) => m >= 8 && m < 10],
    ["10-13", (m) => m >= 10 && m < 13],
    ["13-16", (m) => m >= 13 && m < 16],
    ["16+", (m) => m >= 16],
  ];
  for (const [label, pred] of bands) {
    const n = records.filter((r) => pred(r.margin)).length;
    console.log(`  margin${label}: ${n}件 (${((100 * n) / records.length).toFixed(1)}%)`);
  }
  const ge10 = records.filter((r) => r.margin >= 10).length;
  const ge13 = records.filter((r) => r.margin >= 13).length;
  console.log(`\n  margin>=10: ${ge10}件 / margin>=13: ${ge13}件（全${records.length}件中）`);

  // フィールドサイズ（出走頭数）の分布。formationFromPoolのpoolSizeが
  // margin帯によらず頭打ちしていないか（プールが小さすぎて元から6点未満に
  // なっているレースが多くないか）の確認。
  console.log("\n=== 出走頭数（フィールドサイズ）の分布 ===");
  const sizeCounts = new Map<number, number>();
  for (const r of records) sizeCounts.set(r.fieldSize, (sizeCounts.get(r.fieldSize) ?? 0) + 1);
  for (const [size, n] of [...sizeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size}人: ${n}件`);
  }

  // ---- train/testクロノロジカル分割（開催日で2/3・1/3） ----
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`\ntrain/test分割日: ${splitDate}（train: <${splitDate}, test: >=${splitDate}）`);

  type Candidate = { label: string; build: (axis: number, pool: number[]) => string[] };
  const CANDIDATES: Candidate[] = [
    { label: "現行(budget10=6点)", build: (axis, pool) => formationFromPool(axis, pool, 10) },
    { label: "対称2点(budget2)", build: (axis, pool) => formationFromPool(axis, pool, 2) },
    { label: "非対称tight2点", build: (axis, pool) => tight2(axis, pool) },
  ];

  function evalCandidates(subset: Rec[], heading: string) {
    console.log(`\n--- ${heading}（n=${subset.length}） ---`);
    if (subset.length === 0) {
      console.log("  (該当レースなし)");
      return;
    }
    for (const cand of CANDIDATES) {
      const periods: [string, Rec[]][] = [
        ["全体", subset],
        ["train", subset.filter((r) => r.date < splitDate)],
        ["test", subset.filter((r) => r.date >= splitDate)],
      ];
      const parts: string[] = [];
      for (const [label, recs] of periods) {
        let stake = 0;
        let payout = 0;
        let hits = 0;
        for (const r of recs) {
          const combos = cand.build(r.axisCarNum, r.pool);
          stake += 100 * combos.length;
          if (combos.includes(r.actualCombo)) {
            hits++;
            if (r.hitOdds != null) payout += 100 * r.hitOdds;
          }
        }
        const roi = stake > 0 ? ((payout / stake) * 100).toFixed(1) : "-";
        const hitRate = recs.length > 0 ? ((100 * hits) / recs.length).toFixed(1) : "-";
        parts.push(`${label}:回収率${roi}%(的中${hitRate}%,${hits}/${recs.length},賭け金${stake})`);
      }
      console.log(`  ${cand.label}: ${parts.join(" / ")}`);
    }
  }

  console.log("\n=== 候補フォーメーションの回収率比較（train/testクロノロジカル分割） ===");
  evalCandidates(
    records.filter((r) => r.margin >= 10),
    "margin>=10（全体）"
  );
  evalCandidates(
    records.filter((r) => r.margin >= 10 && r.margin < 13),
    "margin 10-13"
  );
  evalCandidates(
    records.filter((r) => r.margin >= 13),
    "margin>=13"
  );

  await closeDb();
}

main();
