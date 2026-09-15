import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, resolveActualCombo, enableReadCache } from "../lib/repository";
import { CLASS_RANK_SCORES } from "../lib/scoring";
import type { ScoredEntry } from "../lib/types";

/**
 * 【検証結果: 不採用（3案とも採用基準に届かず。lib/scoring.ts・compute-picks.tsへの変更なし）】
 *
 * バリカタ（barikata_picks、margin>=8かつ予想1-2-3位が同ラインの時だけ単一の並びを
 * 100円で買う、db/schema.sql参照）の的中率をさらに上げられないか、ユーザーの
 * 競輪知識に基づく3つの提案を検証した：
 *  ①ライン決着だけでなく、3着は「強い別ライン/単騎」でも可とする
 *    （scripts/diagnose-barikata-top2line.tsで見つかった「予想1-2位のみ同ライン・
 *    3位は別/単騎」という的中率の低い母集団を、3位候補の"強さ"で絞り込めないか）
 *  ②2車の逃げライン（先頭が脚質「逃」）+ 強い単騎が3着、という①の特殊系
 *  ③番手捲り（脚質が逃/両の番手が自ライン先頭を差す。lib/scoring.ts L1625-1638・
 *    scripts/diagnose-bantecha-makuri.tsで検証済みかつ「まくり/差し一撃」
 *    シナリオには実装済みだが、バリカタの単一並びには未反映）が起きやすい局面で、
 *    (a) 並びを番手→先頭→3着に入れ替えるべきか、
 *    (b) 3車ラインの3番手が千切られやすいなら3着を①の強い別ライン候補に
 *        差し替えるべきか
 *
 * ■ 方法
 * predictRace（lib/predict.ts）をmargin>=8・9車立て以外・結果確定済みの全レースに
 * 対して実行（scored.length===9の除外はcompute-picks.tsのmarginCandidatesと同じ、
 * 12,064レース候補中1,481件が対象）。的中判定・払戻オッズはlib/repository.tsの
 * resolveActualCombo（3連単オッズの組み合わせが1種類だけの時のみ公式着順として
 * 採用、複数通りある古いデータはresults.finish_posから組み立て）をそのまま使用。
 * train/testは対象レースの開催日で2/3・1/3にクロノロジカル分割（分割日20260724、
 * train229件/test126件、baseline母集団基準）。predictRace1回のフルスキャン結果を
 * TEMP直下にJSONキャッシュし、分析ロジックの調整だけなら再スキャンなしで
 * 何度でもやり直せるようにした（フルスキャンは今回約25分）。
 * scripts/diagnose-barikata-top2line.ts（作業開始時点で実行中だったため待って
 * 結果を確認、再実行はせず）の粗い数字（margin>=8累積: 同ライン28.0%/
 * 1-2位のみ同ライン7.5%/1-2位すら別ライン11.7%、n=361/466/691）と、本スクリプトの
 * baseline/P1（n=355/450、9車立て除外分だけ母数が減るが同じ35件的中で7.8%）が
 * 一致し、再現性を確認した。
 *
 * ■ baseline（現行の同ライン限定ロジック、確認用）
 *   sameLine3: n=355 的中28.5%(101/355) 回収率123.8%（train111.6%/test145.9%、
 *   両期間とも黒字で安定。現行ロジックは引き続き妥当）。
 *
 * ■ ①の検証: 「予想1-2位のみ同ライン・3位は別/単騎」(P1, n=450) の的中率は
 *   baselineよりはるかに低い7.8%（train124.8%/test89.9%、この時点で既に
 *   train/testの回収率が30pt以上ブレて不安定）。3位候補（=outsider、P1では
 *   常にscored[2]と一致することを確認済み）の"強さ"で絞り込めるか試したが：
 *   - 単騎(outsiderLineSize=1): n=6（母数薄すぎて判定不能、0/6的中）
 *   - 複数人ライン(outsiderLineSize>=2): n=444（P1の98.7%を占め、7.9%とP1
 *     全体とほぼ同じ数字を再現するだけ＝この切り口では絞り込めていない）
 *   - 単騎×class_rank A1以上/A2以下: n=2/n=4（母数皆無、判定不能）
 *   - スコア差gap（対抗-outsider）帯別: gap<5(n=328)は5.8%とP1全体より
 *     むしろ低い（「拮抗している方が強い3着」という直感と逆）。gap5-10(n=104)は
 *     train回収率283.6%対test28.0%と大きくブレて過学習の典型パターン。
 *     gap10-15(n=17)は29.4%的中と好数字だが train13件/test4件では判断材料に
 *     ならない薄さ。
 *   → 「3位が強い別ライン/単騎かどうか」を測るどの軸でも、既知の弱い近い外れの
 *   水準（7.5-12%、db/schema.sqlのbarikata_near_missesコメント参照）を安定して
 *   上回る部分集合を見つけられなかった。単騎自体がこの母集団にほぼ存在しない
 *   （margin>=8で軸ペアが強い時点で、本当に強い単騎ならもっと上位に来て
 *   軸候補になるため）ため「強い単騎」パターンで検証すること自体が難しい。
 *   不採用（薄い/不安定なサブセットに頼らないと成立せず、この規模のデータでは
 *   信頼できる改善を確認できない）。
 *
 * ■ ②の検証: 「2車の逃げライン＋強い単騎が3着」(axisLineSize=2・senko脚質=逃・
 *   outsiderが単騎かつA1以上) は該当n=1（実質存在しない）。条件を緩めて単騎制約を
 *   外した「2車逃げラインのみ」でもn=19（train15/test4）、回収率train36.0%/
 *   test95.0%とどちらも赤字寄りで薄い。①がそもそも不採用な以上②単独でも
 *   採用できる材料はない。不採用（母数不足で検証不能、diagnose-gear-meet-change.ts
 *   と同種の「実行不可能、ここで打ち切り」パターン）。
 *
 * ■ ③aの検証: sameLine3かつscored[0]=先頭・scored[1]=番手（標準順が既に
 *   先頭→番手→3rdになっている、sameLine3の68.7%を占める主流パターン、n=244）を
 *   番手の脚質で分割：
 *   - 番手が逃/両（捲り出やすい、n=35）: 標準順(先頭-番手-3rd)は的中34.3%・
 *     回収率133.4%（train127.4%/test145.0%、両期間黒字で安定）。入替
 *     (番手-先頭-3rd)は的中2.9%・回収率8.9%（train13.5%/test0%）と壊滅的に悪化。
 *   - 番手が追（対照群、n=209）: 標準順は的中35.4%・回収率117.6%（両期間黒字）、
 *     入替は的中5.3%・回収率73.8%。
 *   同一母集団での順序入替のみの比較（このリポジトリで必須の方法論）で、
 *   捲り出やすい群でも対照群でも入替は一貫して大幅に悪化し、方向は完全に
 *   一致（train/testとも入替側が負け）。既存検証（diagnose-bantecha-makuri.ts）の
 *   「番手が脚質逃/両の時、58.5%/54.7%の確率で自ライン先頭を着順で上回る」は
 *   事実だが、これは番手が先頭を"追い抜く"かどうかの相対関係であり、レース
 *   そのものの1着（＝総合スコア1位＝先頭であることが多い）になりやすいかとは
 *   別問題だった。番手が先頭を上回る時の大半は「先頭が崩れて番手が2-3着に
 *   格上げされる」形であり「番手が1着を奪う」形ではないと解釈できる。
 *   不採用（想定と逆方向、しかもtrain/testとも一貫して逆方向＝過学習ではなく
 *   本物の逆効果）。
 *
 * ■ ③bの検証: 3番手「千切られ」の代理指標（diagnose-chigirare.tsと同じ発想、
 *   ただし今回は番手ではなく3番手が対象。先頭が着順判明していることを条件に、
 *   3番手の着順を3着/4着(接戦)/5着以下(ちぎられ)に3分類）：
 *   - 番手が逃/両(n=45): 3着着地46.7% 接戦15.6% ちぎられ26.7%
 *   - 番手が追(n=165、対照群)  : 3着着地47.9% 接戦15.8% ちぎられ24.8%
 *   → 「攻撃的な番手だと3番手が千切られやすい」という前提が、対照群とほぼ
 *   同じ数字（26.7%対24.8%、差2pt）でtrain/testを見るまでもなく支持されない。
 *   実際の買い目としての比較（3車ライン・番手逃/両, n=72）でも：
 *   3着=3番手のまま・標準順(先頭-番手-3番手)が的中22.2%・回収率165.6%
 *   （train97.6%/test285.8%、n=46/26と薄いが両期間ともプラス方向）と最も良く、
 *   3着を①の「強いoutsider」に差し替えると的中1.4%・回収率4.0%まで悪化した
 *   （n=70限定でも同様）。3番手をそのまま3着に置くほうが、①で試した外部候補
 *   より明確に優れている。不採用（前提となる相関自体が確認できず、実際の
 *   買い目性能も悪化する）。
 *
 * ■ 総合判断
 * 3案とも、同一母集団での厳密な比較（train/testクロノロジカル分割、既存の
 * 同ラインbaselineとの直接比較）に耐えなかった。①③はいずれも「既存の強い
 * シグナル（同ライン1-2-3位、総合スコア1位）を上書き・拡張しようとすると
 * 悪化する」という、このプロジェクトで繰り返し確認されてきたパターン
 * （scripts/diagnose-senko-issha.ts等）と同種。③aは特に、まくり/差し一撃
 * シナリオ（フォーメーション買い、2-3着への含有で恩恵を受ける）では効いた
 * 「番手捲り」の知見が、バリカタ（単一並びの1着固定）には方向を変えて
 * 悪影響を及ぼすという、ベット形式によって同じ相関の生かし方が違うという
 * 教訓が得られた。lib/scoring.ts・scripts/compute-picks.tsへの変更は行わない
 * （現行の「margin>=8かつ予想1-2-3位が同ライン」条件のまま）。
 */

// ---- データ収集（predictRace 1回のフルスキャンをJSONにキャッシュし、分析だけ
//      何度もやり直せるようにする。フルスキャンは10-30分かかるため）。
const IS_SMOKE = process.argv.some((a) => a.startsWith("--smoke="));
const CACHE_PATH = path.join(
  process.env.TEMP ?? process.env.TMP ?? ".",
  IS_SMOKE ? "claude-scratch-barikata-expansion-smoke.json" : "claude-scratch-barikata-expansion.json"
);

interface Rec {
  raceId: number;
  date: string;
  margin: number;
  fieldSize: number;
  car0: number;
  car1: number;
  car2: number;
  lg0: number | null;
  lg1: number | null;
  lg2: number | null;
  axisLineSize: number;
  sameLine3: boolean;
  top2SameLine: boolean;
  scored0Pos: string | null; // scored[0]のline_position
  scored1Pos: string | null;
  senkoCar: number | null;
  senkoKyakushitsu: string | null;
  senkoScoreRank: number | null; // scored配列内でのindex
  bantesuCar: number | null;
  bantesuKyakushitsu: string | null;
  bantesuScoreRank: number | null;
  sanbanCar: number | null; // 3番手（axisLineSize===3の時のみ）
  sanbanScoreRank: number | null;
  outsiderCar: number | null; // axisライン外で最もtotalScoreが高い1頭
  outsiderLineSize: number | null;
  outsiderClassRank: string | null;
  outsiderScore: number | null;
  axis2ndScore: number; // scored[1].totalScore
  finishSenko: number | null;
  finishBantesu: number | null;
  finishSanban: number | null;
  finishOutsider: number | null;
  actualCombo: string | null;
  hitOdds: number | null;
}

function lineSizeOf(scored: ScoredEntry[], lg: number | null): number {
  if (lg == null) return 1;
  return scored.filter((s) => s.entry.line_group === lg).length;
}

function findByPosition(scored: ScoredEntry[], lg: number | null, pos: string): ScoredEntry | undefined {
  if (lg == null) return undefined;
  return scored.find((s) => s.entry.line_group === lg && s.entry.line_position === pos);
}

async function collect(): Promise<Rec[]> {
  enableReadCache();
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  let races = raceRows.rows as unknown as { id: number }[];
  const smokeArg = process.argv.find((a) => a.startsWith("--smoke="));
  if (smokeArg) races = races.slice(-Number(smokeArg.split("=")[1]));
  console.log(`対象レース候補: ${races.length}件`);

  const records: Rec[] = [];
  const BATCH = 60;
  let done = 0;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race): Promise<Rec | null> => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 3) return null;
        if (prediction.scored.length === 9) return null; // compute-picks.tsと同じ除外
        const { scored, race: raceRow } = prediction;

        const margin = scored[0].totalScore - scored[1].totalScore;
        if (margin < 8) return null; // BARIKATA_MIN_MARGIN

        const raceResults = await getResultsForRace(race.id);
        const odds = (await getOddsForRace(race.id)).filter((o) => o.bet_type === "3連単");
        const actualCombo = resolveActualCombo(raceResults, odds);
        const hitOdds = actualCombo != null ? odds.find((o) => o.combination === actualCombo)?.odds_value ?? null : null;
        const finishByCar = new Map(raceResults.map((r) => [r.car_num, r.finish_pos]));

        const lg0 = scored[0].entry.line_group;
        const lg1 = scored[1].entry.line_group;
        const lg2 = scored[2].entry.line_group;
        const axisLineSize = lineSizeOf(scored, lg0);
        const sameLine3 = lg0 != null && lg0 === lg1 && lg1 === lg2;
        const top2SameLine = lg0 != null && lg0 === lg1;

        const senko = findByPosition(scored, lg0, "先頭");
        const bantesu = findByPosition(scored, lg0, "番手");
        const sanban = axisLineSize === 3 ? findByPosition(scored, lg0, "3番手") : undefined;

        // axisライン外（lg0と異なる）で最もtotalScoreが高い1頭
        const outsider = scored
          .filter((s) => s.entry.line_group !== lg0)
          .sort((a, b) => b.totalScore - a.totalScore)[0];

        const rec: Rec = {
          raceId: race.id,
          date: raceRow.kaisai_date,
          margin,
          fieldSize: scored.length,
          car0: scored[0].entry.car_num,
          car1: scored[1].entry.car_num,
          car2: scored[2].entry.car_num,
          lg0,
          lg1,
          lg2,
          axisLineSize,
          sameLine3,
          top2SameLine,
          scored0Pos: scored[0].entry.line_position,
          scored1Pos: scored[1].entry.line_position,
          senkoCar: senko?.entry.car_num ?? null,
          senkoKyakushitsu: senko?.entry.kyakushitsu ?? null,
          senkoScoreRank: senko ? scored.indexOf(senko) : null,
          bantesuCar: bantesu?.entry.car_num ?? null,
          bantesuKyakushitsu: bantesu?.entry.kyakushitsu ?? null,
          bantesuScoreRank: bantesu ? scored.indexOf(bantesu) : null,
          sanbanCar: sanban?.entry.car_num ?? null,
          sanbanScoreRank: sanban ? scored.indexOf(sanban) : null,
          outsiderCar: outsider?.entry.car_num ?? null,
          outsiderLineSize: outsider ? lineSizeOf(scored, outsider.entry.line_group) : null,
          outsiderClassRank: outsider?.entry.class_rank ?? null,
          outsiderScore: outsider?.totalScore ?? null,
          axis2ndScore: scored[1].totalScore,
          finishSenko: senko ? finishByCar.get(senko.entry.car_num) ?? null : null,
          finishBantesu: bantesu ? finishByCar.get(bantesu.entry.car_num) ?? null : null,
          finishSanban: sanban ? finishByCar.get(sanban.entry.car_num) ?? null : null,
          finishOutsider: outsider ? finishByCar.get(outsider.entry.car_num) ?? null : null,
          actualCombo,
          hitOdds,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    done += batch.length;
    if (done % 1200 === 0) console.log(`  進捗 ${done}/${races.length}`);
  }
  console.log(`margin>=8・predictRace成功・結果確定: ${records.length}件`);
  return records;
}

async function loadOrCollect(): Promise<Rec[]> {
  if (existsSync(CACHE_PATH)) {
    console.log(`キャッシュを使用: ${CACHE_PATH}`);
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  }
  const records = await collect();
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(records));
    console.log(`キャッシュ保存: ${CACHE_PATH}`);
  } catch (e) {
    console.warn("キャッシュ保存失敗（分析は続行）", e);
  }
  return records;
}

// ---- 分析ヘルパー ----

function splitDate(records: Rec[]): string {
  const dates = [...new Set(records.map((r) => r.date))].sort();
  return dates[Math.floor(dates.length * (2 / 3))];
}

interface Stat {
  n: number;
  hits: number;
  hitRate: number;
  roi: number | null;
}

function evalCombo(recs: Rec[], comboFn: (r: Rec) => string | null): Stat {
  let n = 0;
  let hits = 0;
  let stake = 0;
  let payout = 0;
  for (const r of recs) {
    const combo = comboFn(r);
    if (combo == null) continue;
    n++;
    stake += 100;
    if (combo === r.actualCombo) {
      hits++;
      if (r.hitOdds != null) payout += 100 * r.hitOdds;
    }
  }
  return { n, hits, hitRate: n > 0 ? (100 * hits) / n : 0, roi: stake > 0 ? (100 * payout) / stake : null };
}

function fmt(s: Stat): string {
  return `n=${s.n} 的中${s.hitRate.toFixed(1)}%(${s.hits}/${s.n}) 回収率${s.roi?.toFixed(1) ?? "-"}%`;
}

function reportTrainTest(label: string, recs: Rec[], split: string, comboFn: (r: Rec) => string | null) {
  const all = evalCombo(recs, comboFn);
  const train = evalCombo(recs.filter((r) => r.date < split), comboFn);
  const test = evalCombo(recs.filter((r) => r.date >= split), comboFn);
  console.log(`  ${label}: 全体${fmt(all)}`);
  console.log(`    train:${fmt(train)} / test:${fmt(test)}`);
}

const A1_PLUS = 55; // CLASS_RANK_SCORES閾値（A1以上）

function classScore(rank: string | null): number {
  return rank ? CLASS_RANK_SCORES[rank] ?? 50 : 50;
}

async function main() {
  const records = await loadOrCollect();
  const split = splitDate(records);
  console.log(`\ntrain/test分割日: ${split}（train: <${split}, test: >=${split}）\n`);

  // ============================================================
  // 【baseline】現行バリカタ（同ライン1-2-3、スコア順そのまま）
  // ============================================================
  console.log("=".repeat(70));
  console.log("■ baseline: 現行バリカタ（sameLine3、car0-car1-car2）");
  console.log("=".repeat(70));
  const baselinePop = records.filter((r) => r.sameLine3);
  reportTrainTest("現行", baselinePop, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  // ============================================================
  // 【近い外れの全体像】sameLine3ではないもの
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ 参考: 近い外れ全体（top2SameLine有無で分割、car0-car1-car2そのまま）");
  console.log("=".repeat(70));
  const nearMissAll = records.filter((r) => !r.sameLine3);
  reportTrainTest("近い外れ全体", nearMissAll, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  const p1 = records.filter((r) => r.top2SameLine && !r.sameLine3);
  reportTrainTest("うちtop2SameLine（=P1、①の対象母集団）", p1, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  const p1other = records.filter((r) => !r.top2SameLine && !r.sameLine3);
  reportTrainTest("うち1-2位すら別ライン（参考、①の対象外）", p1other, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  // sanity check: P1ではoutsiderCar === car2のはず
  const mismatch = p1.filter((r) => r.outsiderCar !== r.car2).length;
  console.log(`  (整合性チェック: P1でoutsiderCar!==car2の件数=${mismatch}件/${p1.length}件、0であるべき)`);

  // ============================================================
  // 【idea① 検証】P1を「3着(=outsider)が強いかどうか」で絞り込む
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ idea①: P1を outsider の強さで絞り込み");
  console.log("=".repeat(70));

  console.log("\n-- ①-a: outsiderLineSize別 --");
  const p1Solo = p1.filter((r) => r.outsiderLineSize === 1);
  const p1Multi = p1.filter((r) => (r.outsiderLineSize ?? 0) >= 2);
  reportTrainTest("単騎(outsiderLineSize=1)", p1Solo, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("複数人ライン(outsiderLineSize>=2)", p1Multi, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  console.log("\n-- ①-b: 単騎のみ、class_rank別 --");
  const p1SoloStrong = p1Solo.filter((r) => classScore(r.outsiderClassRank) >= A1_PLUS);
  const p1SoloWeak = p1Solo.filter((r) => classScore(r.outsiderClassRank) < A1_PLUS);
  reportTrainTest("単騎かつA1以上", p1SoloStrong, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("単騎かつA2以下", p1SoloWeak, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  console.log("\n-- ①-c: gap（axis2ndScore - outsiderScore）帯別 --");
  const gapBands: [string, (r: Rec) => boolean][] = [
    ["gap<5", (r) => r.axis2ndScore - (r.outsiderScore ?? 0) < 5],
    ["gap5-10", (r) => r.axis2ndScore - (r.outsiderScore ?? 0) >= 5 && r.axis2ndScore - (r.outsiderScore ?? 0) < 10],
    ["gap10-15", (r) => r.axis2ndScore - (r.outsiderScore ?? 0) >= 10 && r.axis2ndScore - (r.outsiderScore ?? 0) < 15],
    ["gap15+", (r) => r.axis2ndScore - (r.outsiderScore ?? 0) >= 15],
  ];
  for (const [label, pred] of gapBands) {
    reportTrainTest(label, p1.filter(pred), split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  }

  console.log("\n-- ①-d: 複合（単騎A1+ or 複数人ライン）を『強いoutsider』として合算 --");
  const p1Strong = p1.filter(
    (r) => (r.outsiderLineSize === 1 && classScore(r.outsiderClassRank) >= A1_PLUS) || (r.outsiderLineSize ?? 0) >= 2
  );
  const p1Weak = p1.filter(
    (r) => !((r.outsiderLineSize === 1 && classScore(r.outsiderClassRank) >= A1_PLUS) || (r.outsiderLineSize ?? 0) >= 2)
  );
  reportTrainTest("強いoutsider（単騎A1+ or 複数人ライン）", p1Strong, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("弱いoutsider（単騎A2以下）", p1Weak, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  // ============================================================
  // 【idea② 検証】2車の逃げライン + 強い単騎
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ idea②: 2車の逃げライン(axisLineSize=2,senko=逃) + 強い単騎outsider");
  console.log("=".repeat(70));
  const p2 = p1.filter(
    (r) =>
      r.axisLineSize === 2 &&
      r.senkoKyakushitsu === "逃" &&
      r.outsiderLineSize === 1 &&
      classScore(r.outsiderClassRank) >= A1_PLUS
  );
  reportTrainTest("2車逃げ+強い単騎3着", p2, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  // 比較: 2車の逃げラインだが単騎条件を課さない場合
  const p2Loose = p1.filter((r) => r.axisLineSize === 2 && r.senkoKyakushitsu === "逃");
  reportTrainTest("(比較)2車逃げラインのみ、outsider制約なし", p2Loose, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  // ============================================================
  // 【idea③a 検証】番手捲り場面での並び入替
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ idea③a: sameLine3 かつ scored0=先頭・scored1=番手 の場面での並び入替");
  console.log("=".repeat(70));
  const p3a = records.filter((r) => r.sameLine3 && r.scored0Pos === "先頭" && r.scored1Pos === "番手");
  console.log(`  対象母集団（標準順が先頭→番手→3rdになっているsameLine3）: n=${p3a.length} (全sameLine3のうち${((100 * p3a.length) / baselinePop.length).toFixed(1)}%)`);

  const p3aOvertakeProne = p3a.filter((r) => r.bantesuKyakushitsu === "逃" || r.bantesuKyakushitsu === "両");
  const p3aNotProne = p3a.filter((r) => r.bantesuKyakushitsu === "追");
  const p3aOther = p3a.filter((r) => r.bantesuKyakushitsu !== "逃" && r.bantesuKyakushitsu !== "両" && r.bantesuKyakushitsu !== "追");
  console.log(`  番手が逃/両(捲り出やすい): n=${p3aOvertakeProne.length} / 番手が追: n=${p3aNotProne.length} / 番手脚質不明等: n=${p3aOther.length}`);

  console.log("\n-- 番手が逃/両（捲り出やすい）--");
  reportTrainTest("標準順(先頭-番手-3rd)", p3aOvertakeProne, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("入替(番手-先頭-3rd)", p3aOvertakeProne, split, (r) => `${r.car1}-${r.car0}-${r.car2}`);

  console.log("\n-- 番手が追（捲り出にくい、対照群）--");
  reportTrainTest("標準順(先頭-番手-3rd)", p3aNotProne, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("入替(番手-先頭-3rd)", p3aNotProne, split, (r) => `${r.car1}-${r.car0}-${r.car2}`);

  // ============================================================
  // 【idea③b 検証】3車ラインの3番手ちぎれ + 3着差し替え
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ idea③b: 3車ラインの番手捲り場面で3番手が千切られるか、差し替えは有効か");
  console.log("=".repeat(70));

  // ちぎられ代理指標: 先頭が3着以内（前2人は仕事をした）の時の3番手の着順分布
  const chigirarePop = records.filter(
    (r) => r.sameLine3 && r.axisLineSize === 3 && r.finishSenko != null && r.finishSenko <= 3 && r.finishSanban != null
  );
  function chigirareBreakdown(recs: Rec[], label: string) {
    const total = recs.length;
    if (total === 0) {
      console.log(`  ${label}: 該当なし`);
      return;
    }
    const wan = recs.filter((r) => r.finishSanban === 3).length; // 理想形＝3着
    const sessen = recs.filter((r) => r.finishSanban === 4).length;
    const chigirare = recs.filter((r) => (r.finishSanban ?? 0) >= 5).length;
    console.log(
      `  ${label}(母数${total}): 3着着地${((100 * wan) / total).toFixed(1)}% ` +
        `接戦(4着)${((100 * sessen) / total).toFixed(1)}% ちぎられ(5着以下)${((100 * chigirare) / total).toFixed(1)}%`
    );
  }
  chigirareBreakdown(chigirarePop.filter((r) => r.bantesuKyakushitsu === "逃" || r.bantesuKyakushitsu === "両"), "番手が逃/両");
  chigirareBreakdown(chigirarePop.filter((r) => r.bantesuKyakushitsu === "追"), "番手が追");

  // 実際の買い目としての比較: 3車ライン・番手が逃/両の母集団で、3着=3番手のまま vs 3着=outsiderに差し替え
  const p3b = records.filter(
    (r) => r.sameLine3 && r.axisLineSize === 3 && (r.bantesuKyakushitsu === "逃" || r.bantesuKyakushitsu === "両")
  );
  console.log(`\n  対象母集団（3車ライン・番手が逃/両）: n=${p3b.length}`);
  const p3bOutsiderStrong = p3b.filter(
    (r) => (r.outsiderLineSize === 1 && classScore(r.outsiderClassRank) >= A1_PLUS) || (r.outsiderLineSize ?? 0) >= 2
  );
  console.log(`  うちoutsiderが強い(①の基準): n=${p3bOutsiderStrong.length}`);

  console.log("\n-- 3着=3番手のまま（標準順 先頭-番手-3番手）--");
  reportTrainTest("先頭-番手-3番手", p3b, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  console.log("-- 3着=3番手のまま（入替 番手-先頭-3番手）--");
  reportTrainTest("番手-先頭-3番手", p3b, split, (r) => `${r.car1}-${r.car0}-${r.car2}`);

  console.log("\n-- 3着=outsiderに差し替え（強いoutsiderに限定、母集団はp3bOutsiderStrong）--");
  reportTrainTest("先頭-番手-outsider", p3bOutsiderStrong, split, (r) => `${r.car0}-${r.car1}-${r.outsiderCar}`);
  reportTrainTest("番手-先頭-outsider", p3bOutsiderStrong, split, (r) => `${r.car1}-${r.car0}-${r.outsiderCar}`);
  console.log("(比較として同じp3bOutsiderStrong母集団での「3番手のまま」)");
  reportTrainTest("先頭-番手-3番手(同母集団)", p3bOutsiderStrong, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("番手-先頭-3番手(同母集団)", p3bOutsiderStrong, split, (r) => `${r.car1}-${r.car0}-${r.car2}`);

  await closeDb();
}

main();
