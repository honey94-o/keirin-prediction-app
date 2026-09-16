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

import { getDb, closeDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { buildLineAwarePool } from "../lib/scoring";
import { enableReadCache } from "../lib/repository";

/**
 * 【検証結果: 不採用（母集団は確保できたが、的中率は改善するのに回収率がtrain/test
 *   とも一貫して100%割れ＝安定して不採算と判明）】
 *
 * scripts/diagnose-barikata-expansion.ts（前日の検証、3案とも不採用）の続き。
 * 前日の①「予想1-2位のみ同ライン・3位を強い別ライン/単騎に差し替え」は
 * 明確に不採用（7.8%、同ラインbaseline28.5%を大きく下回る）だったが、本スクリプトは
 * その"鏡像"にあたる別の仮説を検証する：
 *   前日①＝「3着を軸ライン外の強い選手に差し替える」（outsider-3rd）
 *   本検証＝「予想1-2位のみ同ラインで3着だけ別ラインに出た（＝現在barikata_near_missesに
 *     入り見送りになっている）ケースで、3着を生スコアのoutsiderではなく"軸ライン自身の
 *     残りメンバー"（3番手、4車以上のラインなら4番手も含めbuildLineAwarePool順で
 *     一番手前）に差し替える」（same-line-3rd-substitute）
 * 実際の武雄7R(race_id=27799, 2026-09-16)で、軸ライン(line_group=1、4車:
 * 先頭car1/番手car3/3番手car6/4番手car2)が2車ラインと単騎1車のみという寡占的な
 * フィールドで、生スコア3位が別ラインのcar4だったため近い外れ（1-3-4、不的中）
 * 扱いになったが、実際の着順は1-3-6＝軸ライン自身の3番手だった、というのが
 * 発端（ただしこの1件はあくまで仮説の着想であり、判断はこの1件では行わない。
 * 母集団全体のtrain/test安定性のみで判断する＝前日③aで学んだ「1件の劇的な
 * 例に引きずられない」教訓を踏襲）。
 *
 * ■ 方法・データソース
 * 前日のdiagnose-barikata-expansion.tsが1481件（margin>=8・9車立て除外・結果確定済み）
 * を対象にpredictRaceをフルスキャンしてTEMP直下にキャッシュ済み
 * （claude-scratch-barikata-expansion.json、lib/scoring.ts/lib/repository.tsの
 * 最終更新[2026-09-15 12:42]より後[19:47]に作成されており、現行ロジックと同じ
 * 前提で計算されたものと確認済み）。本スクリプトはこのキャッシュをそのまま再利用し、
 * 「軸ライン自身の残りメンバー」の車番だけを追加で算出する：
 *  - axisLineSize===3（軸ラインの総人数が3）: キャッシュ済みのsenkoCar/bantesuCar/
 *    sanbanCar（いずれもfindByPosition、line_position直読み）のうちcar0/car1と
 *    重複しない1台が機械的に定まる（3人しかいないので選択の余地がない。
 *    検証の結果379件全件で候補がちょうど1つに定まることを確認済み）。
 *  - axisLineSize>=4（4車・5車ライン）: 3番手・4番手はキャッシュに無いため、
 *    該当46件（4車45件+5車1件）だけpredictRaceを再実行し、buildLineAwarePool
 *    （lib/scoring.ts、軸と同じラインを隊列予想＋lineupOrderScore順で並べる関数、
 *    まくり/差し一撃・本命フォーメーション既存ロジックが2・3着プール構築に
 *    使っているのと同じ関数）の戻り値から対抗(car1)を除いた同ライン最上位1台を
 *    「軸ラインの残りメンバー」として採用する。46件のみの再スキャンなので数秒で終わる
 *    （1481件フルスキャンの25分は不要）。
 * 的中判定・オッズはキャッシュ済みのactualCombo/hitOdds（レース単位の事実で
 * 買い目案に依存しないため再取得不要）をそのまま使う。train/testは前日と同じ
 * 分割日（全1481件の開催日で2/3・1/3、20260724）を使う。
 *
 * ■ 母集団サイズ（Step1で確認）
 *   全体（margin>=8・9車立て除外）: n=1481
 *   sameLine3（現行barikata_picks、baseline a）: n=355
 *   top2SameLine && !sameLine3（P1、現行barikata_near_misses相当）: n=450
 *     内訳: axisLineSize=2(3着候補が存在しない・対象外) n=25 /
 *           axisLineSize=3 n=379 / axisLineSize>=4 n=46
 *   → 本検証の対象母集団B（axisLineSize>=3のP1）: n=425（379+46）。
 *   前日想定の「450より薄いはず」の通り、2車ライン25件を除くとn=425に減るが、
 *   diagnose-gear-meet-change.tsで言う「判定不能なほど薄い」水準ではなく、
 *   判定可能な規模と判断した。
 *
 * ■ Step2: baseline (a) 現行同ライン（確認用、前日と同じ数字の再現）
 *   sameLine3: n=355 的中28.5%(101/355) 回収率123.8%
 *     train111.6%(n=229) / test145.9%(n=126) ← 前日の数字と完全一致、再現性確認OK
 *
 * ■ Step3: 母集団B（n=425）での比較（実行結果）
 *  -- B-現状（生スコアのままcar0-car1-car2、＝現行barikata_near_missesの買い目、
 *     見送り扱いだが仮に買っていたら）--
 *   n=425 的中7.5%(32/425) 回収率114.9%（train128.3%(n=272)/test91.0%(n=153)、
 *   train/testで黒字↔赤字が反転＝前日診断のP1（n=450, train124.8%/test89.9%）と
 *   ほぼ同じ数字・同じ不安定さを再現。想定した母集団を正しく捉えている確認になった）。
 *  -- B-差し替え（car0-car1-substituteCar、軸ラインの残りメンバー）--
 *   n=425 的中17.9%(76/425) 回収率83.0%（train86.6%(n=272)/test76.7%(n=153)）。
 *   的中率は現状の7.5%から17.9%へ2.4倍に跳ね上がり、「軸ラインが3着まで独占
 *   しやすい」という着想の"当たりやすさ"自体は数字で裏付けられた。
 *   しかし回収率はtrain・testとも一貫して100%を下回る（86.6%→76.7%、方向が
 *   ブレず両期間とも赤字）。的中率が上がった分、的中時の平均オッズが下がった
 *   （軸ライン総取りは想定内の「本命党」の並びで市場に織り込まれ低配当になりやすい）
 *   ため、掛け金に対して回収しきれていない。
 *  -- 参考: 同ラインbaseline(a)との比較（アプローチが違うため直接の目標値ではないが） --
 *   sameLine3の回収率123.8%（train111.6%/test145.9%、両期間黒字）には遠く及ばない。
 *
 * ■ Step4: ライン人数別（3車 vs 4車以上）（実行結果）
 *   axisLineSize===3 (n=379): 現状7.7%的中/回収率117.6%（train127.8%/test100.1%）、
 *     差し替え17.7%的中/回収率86.9%（train92.9%/test76.5%）。母集団Bの大半（89%）を
 *     占めるこのサブセット単独でも、差し替えは両期間とも100%以下＝結論は変わらない。
 *   axisLineSize>=4 (n=46): 現状6.5%的中/回収率92.4%（train132.8%(n=32)/
 *     test0.0%(n=14、的中0件)）、差し替え19.6%的中/回収率51.3%（train39.4%/
 *     test78.6%）。武雄7Rの着想元となった4車以上ラインの場面そのものだが、
 *     n=46・testはn=14まで薄く、diagnose-barikata-expansion.ts②の「n=19ですら
 *     薄い」という前例同様、これ単独では判断材料にならない。ただし主要部
 *     （3車ライン、n=379）と方向は一致しており、4車以上だけ都合よく良い数字が
 *     出ているわけでもない。
 *
 * ■ 総合判断
 *   母集団は確保できた（n=425、前日のP1のように「判定不能なほど薄い」水準では
 *   ない）。「軸ラインが3着まで独占しやすい」という着想の的中率面での裏付けは
 *   train/testとも安定して得られた（7.5%→17.9%、方向は完全に一致）。しかし
 *   ベットとしての実利（回収率）で見ると、差し替え案はtrain86.6%・test76.7%と
 *   train/testどちらも一貫して100%を下回る＝「安定して不採算」という、前日の
 *   ①③aで見た「train/testで方向がブレる不安定な過学習」とは異なる、より
 *   明確な種類の不採用理由になった。現状の「見送り（0円、the near-missは
 *   一切ベットしない）」と比べても、差し替えて毎回100円賭けるほうが期待値が
 *   低い（見送りは損益0、差し替えは-13〜-23%の期待損失）。的中率が上がっても
 *   同時にオッズが下がるため回収率では勝てないという、このプロジェクトで
 *   何度も見た「単独の相関は本物でも実装すると損益で報われない」パターンの
 *   一種と判断し、不採用とする。lib/scoring.ts・scripts/compute-picks.tsへの
 *   変更は行わない（現行のsameLine限定ロジックのまま、このケースは引き続き
 *   barikata_near_missesで見送り扱いとする）。
 */

const CACHE_PATH = path.join(process.env.TEMP ?? process.env.TMP ?? ".", "claude-scratch-barikata-expansion.json");
const SUBSTITUTE_CACHE_PATH = path.join(
  process.env.TEMP ?? process.env.TMP ?? ".",
  "claude-scratch-barikata-line-substitute-4plus.json"
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
  senkoCar: number | null;
  bantesuCar: number | null;
  sanbanCar: number | null;
  actualCombo: string | null;
  hitOdds: number | null;
}

interface Substitute4Plus {
  raceId: number;
  substituteCar: number | null;
  freshCar0: number;
  freshCar1: number;
  freshLg0: number | null;
}

async function loadBaseCache(): Promise<Rec[]> {
  if (!existsSync(CACHE_PATH)) {
    throw new Error(
      `前日のキャッシュが見つからない: ${CACHE_PATH}\n` +
        `scripts/diagnose-barikata-expansion.tsを先に実行してキャッシュを作るか、` +
        `本スクリプトにフルスキャンのフォールバックを追加すること。`
    );
  }
  return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
}

async function computeSubstitutes4Plus(targets: Rec[]): Promise<Substitute4Plus[]> {
  if (existsSync(SUBSTITUTE_CACHE_PATH)) {
    console.log(`4車以上サブ差し替えキャッシュを使用: ${SUBSTITUTE_CACHE_PATH}`);
    return JSON.parse(readFileSync(SUBSTITUTE_CACHE_PATH, "utf-8"));
  }
  enableReadCache();
  console.log(`axisLineSize>=4の${targets.length}件だけpredictRaceを再実行してsubstituteCarを算出...`);
  const results: Substitute4Plus[] = [];
  for (const r of targets) {
    const prediction = await predictRace(r.raceId);
    if (!prediction) {
      results.push({ raceId: r.raceId, substituteCar: null, freshCar0: -1, freshCar1: -1, freshLg0: null });
      continue;
    }
    const { scored } = prediction;
    const axis = scored[0];
    const taikou = scored[1];
    const lg0 = axis.entry.line_group;
    if (axis.entry.car_num !== r.car0 || taikou.entry.car_num !== r.car1 || lg0 !== r.lg0) {
      console.warn(
        `  警告: raceId=${r.raceId} キャッシュと現在のpredictRace結果が不一致` +
          `（cache car0/car1/lg0=${r.car0}/${r.car1}/${r.lg0} vs fresh=${axis.entry.car_num}/${taikou.entry.car_num}/${lg0}）。` +
          `新しい値を使う。`
      );
    }
    const pool = buildLineAwarePool(axis.entry.car_num, lg0, scored);
    const byCar = new Map(scored.map((s) => [s.entry.car_num, s.entry]));
    const substituteCar =
      pool.find((car) => car !== taikou.entry.car_num && byCar.get(car)?.line_group === lg0) ?? null;
    results.push({
      raceId: r.raceId,
      substituteCar,
      freshCar0: axis.entry.car_num,
      freshCar1: taikou.entry.car_num,
      freshLg0: lg0,
    });
  }
  try {
    writeFileSync(SUBSTITUTE_CACHE_PATH, JSON.stringify(results));
    console.log(`キャッシュ保存: ${SUBSTITUTE_CACHE_PATH}`);
  } catch (e) {
    console.warn("キャッシュ保存失敗（分析は続行）", e);
  }
  return results;
}

// ---- 分析ヘルパー（diagnose-barikata-expansion.tsと同じ様式） ----

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

function evalCombo<T extends { date: string; actualCombo: string | null; hitOdds: number | null }>(
  recs: T[],
  comboFn: (r: T) => string | null
): Stat {
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

function reportTrainTest<T extends { date: string; actualCombo: string | null; hitOdds: number | null }>(
  label: string,
  recs: T[],
  split: string,
  comboFn: (r: T) => string | null
) {
  const all = evalCombo(recs, comboFn);
  const train = evalCombo(
    recs.filter((r) => r.date < split),
    comboFn
  );
  const test = evalCombo(
    recs.filter((r) => r.date >= split),
    comboFn
  );
  console.log(`  ${label}: 全体${fmt(all)}`);
  console.log(`    train:${fmt(train)} / test:${fmt(test)}`);
}

async function main() {
  const records = await loadBaseCache();
  const split = splitDate(records);
  console.log(`\ntrain/test分割日: ${split}（train: <${split}, test: >=${split}）`);
  console.log(`全体母集団（margin>=8・9車立て除外）: n=${records.length}\n`);

  const sameLine3 = records.filter((r) => r.sameLine3);
  const p1 = records.filter((r) => r.top2SameLine && !r.sameLine3);
  const p1by2 = p1.filter((r) => r.axisLineSize === 2);
  const p1by3 = p1.filter((r) => r.axisLineSize === 3);
  const p1by4plus = p1.filter((r) => r.axisLineSize >= 4);

  console.log("=".repeat(70));
  console.log("■ Step1: 母集団サイズ確認");
  console.log("=".repeat(70));
  console.log(`  sameLine3 (baseline a)           : n=${sameLine3.length}`);
  console.log(`  P1 (top2SameLine && !sameLine3)  : n=${p1.length}`);
  console.log(`    うちaxisLineSize=2 (対象外、3着候補なし): n=${p1by2.length}`);
  console.log(`    うちaxisLineSize=3               : n=${p1by3.length}`);
  console.log(`    うちaxisLineSize>=4               : n=${p1by4plus.length}`);
  console.log(`  母集団B（axisLineSize>=3のP1）      : n=${p1by3.length + p1by4plus.length}`);

  // ============================================================
  // baseline (a): 現行同ライン（再現確認）
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ Step2: baseline (a) 現行バリカタ（sameLine3、再現確認）");
  console.log("=".repeat(70));
  reportTrainTest("現行(car0-car1-car2)", sameLine3, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  // ============================================================
  // axisLineSize===3: 差し替え車番をキャッシュから機械的に導出
  // ============================================================
  const substituteBy3 = new Map<number, number>();
  for (const r of p1by3) {
    const candidates = [r.senkoCar, r.bantesuCar, r.sanbanCar].filter(
      (c): c is number => c != null && c !== r.car0 && c !== r.car1
    );
    const uniq = [...new Set(candidates)];
    if (uniq.length !== 1) {
      console.warn(`  警告: raceId=${r.raceId} axisLineSize=3で候補が${uniq.length}件（想定1件）`);
      continue;
    }
    substituteBy3.set(r.raceId, uniq[0]);
  }

  // ============================================================
  // axisLineSize>=4: buildLineAwarePoolで再算出
  // ============================================================
  const subs4 = await computeSubstitutes4Plus(p1by4plus);
  const substituteBy4 = new Map<number, number>();
  for (const s of subs4) {
    if (s.substituteCar != null) substituteBy4.set(s.raceId, s.substituteCar);
  }

  const bothB = [...p1by3, ...p1by4plus]
    .map((r) => {
      const substituteCar = substituteBy3.get(r.raceId) ?? substituteBy4.get(r.raceId) ?? null;
      return { ...r, substituteCar };
    })
    .filter((r) => r.substituteCar != null);

  console.log(
    `\n  (整合性チェック: 母集団B ${p1by3.length + p1by4plus.length}件中、substituteCarが算出できたのは${bothB.length}件)`
  );

  // sanity: substituteCar は必ずcar2と異なるはず（母集団Bはscored[2]が別ラインなので）
  const collideWithCar2 = bothB.filter((r) => r.substituteCar === r.car2).length;
  console.log(`  (整合性チェック: substituteCar===car2の件数=${collideWithCar2}件、0であるべき)`);

  // ============================================================
  // Step3: 母集団Bでの比較
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ Step3: 母集団B（axisLineSize>=3のP1、n=" + bothB.length + "）での比較");
  console.log("=".repeat(70));

  console.log("\n-- B-現状（生スコアそのままcar0-car1-car2、現行barikata_near_misses相当）--");
  reportTrainTest("現状(近い外れ)", bothB, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);

  console.log("\n-- B-差し替え（car0-car1-substituteCar、軸ラインの残りメンバー）--");
  reportTrainTest("差し替え(新案)", bothB, split, (r) => `${r.car0}-${r.car1}-${r.substituteCar}`);

  // ============================================================
  // Step4: ライン人数別
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("■ Step4: ライン人数別（3車 vs 4車以上）での差し替え成績");
  console.log("=".repeat(70));

  const bothB3 = bothB.filter((r) => r.axisLineSize === 3);
  const bothB4plus = bothB.filter((r) => r.axisLineSize >= 4);

  console.log(`\n-- axisLineSize===3 (n=${bothB3.length}) --`);
  reportTrainTest("現状(近い外れ)", bothB3, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("差し替え(新案)", bothB3, split, (r) => `${r.car0}-${r.car1}-${r.substituteCar}`);

  console.log(`\n-- axisLineSize>=4 (n=${bothB4plus.length}) --`);
  reportTrainTest("現状(近い外れ)", bothB4plus, split, (r) => `${r.car0}-${r.car1}-${r.car2}`);
  reportTrainTest("差し替え(新案)", bothB4plus, split, (r) => `${r.car0}-${r.car1}-${r.substituteCar}`);

  await closeDb();
}

main();
