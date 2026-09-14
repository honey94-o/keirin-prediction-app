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
import { parseEncp } from "../lib/date";

/**
 * 【検証結果: 不採用（仮説と逆方向。平均回帰では説明しきれないが、モメンタムでもない）】
 *
 * ユーザー仮説：同一開催（races.encpのcupId）内で、選手の開催序盤の着順トレンド
 * （1走目→2走目で着順が良化/悪化/変わらず）が、そのトレンド算出に一切使っていない
 * 3走目の勝率を予測するか（heikin_tokuten/class_rankが既に説明する分を超えて）。
 * 「開催中に調子を掴んだ選手はその後も乗ってくる、逆に想定外に崩れた選手は
 * 何らかの実質的な問題（ライン相性・体調・機材）を抱えている」という競輪の
 * 実感を検証する。
 *
 * トートロジー回避：trend算出に使うのはrace[0]・race[1]のfinish_posのみで、
 * 勝敗を測るrace[2]のfinish_posはtrend計算に一切混ぜない
 * （このセッションで既に一度、「オーバーテイクしたか」という勝利の準必要条件を
 * 勝率計算の条件にしてしまい相関を水増しした失敗をしており、同じ轍を踏まない
 * ための設計）。
 *
 * 対象：(snum, cup_id)ごとに、finish_posが非nullなwt:接頭レースをkaisai_date→
 * race_noの順にソートし、3走以上ある組だけ最初の3走 race[0]/race[1]/race[2]を
 * 使う（4走目以降は無視）。
 *   trend = finish_pos[1] - finish_pos[0]（負=良化=improved、0=flat、正=悪化=declined）
 *   outcome = finish_pos[2] === 1（trendの計算に使っていない3走目の勝敗）
 *
 * ■ サンプルサイズ
 * 対象出走（wt:接頭、finish_pos非null）: 83,766件。
 * (snum, cup_id)組 2走以上: 27,372件、3走以上（分析対象）: 26,022件
 * （ユーザーの事前フィージビリティチェックと一致）。
 * 内訳: improved 10,784件 / flat 4,353件 / declined 10,885件。
 *
 * ■ Step1: 生の相関（全体、race[2]勝率）
 *   improved: 12.9%(train13.2%/test12.3%, n=10784)  race[0]平均着順=5.48
 *   flat    : 17.4%(train17.1%/test18.0%, n=4353)   race[0]平均着順=3.69
 *   declined: 14.7%(train14.5%/test15.2%, n=10885)  race[0]平均着順=2.69
 * 仮説の予測（improvedが最も高い）とは逆に、improvedが3群中で最も勝率が低く、
 * flatが最も高い。train/testとも同じ順序（improved<declined<flat）で再現しており、
 * ノイズではない。
 *
 * ■ Step2: heikin_tokuten三分位で層別（三分位境界: 79.8 / 91.8）
 * 各帯の「trend問わずの基準勝率」に対し、improvedは全帯で明確に下回った：
 *   低位帯（基準12.4%, n=8658）: improved10.6% flat15.2% declined12.8%
 *   中位帯（基準14.1%, n=8689）: improved12.6% flat17.0% declined14.6%
 *   高位帯（基準16.7%, n=8675）: improved15.2% flat20.8% declined16.7%
 * train/testとも同方向（高位帯のtestでimproved13.5%とやや下振れするが、
 * 全帯・全期間でimproved<基準<=declined<flatの順序は崩れない）。
 * class_rank別（Step3、n>=100の級のみ）でも、A2/A1/S1/S2/A3/L1の6区分すべてで
 * improvedがその級の基準勝率を下回った（L1は基準14.3%に対しimproved7.4%と
 * 特に大きく下振れ）。heikin_tokuten/class_rankどちらで統制しても再現するため、
 * 実力の言い換え（単純な交絡）ではない。
 *
 * ■ 平均回帰の切り分け（このhypothesisで最重要の論点）
 * 事前の想定は「improved群はrace[0]でのフロック的な悪結果からの回帰であり、
 * 本来の実力（=基準勝率）に戻るだけなら平均回帰、基準勝率を上回れば本物の
 * モメンタム」というものだった。実際の結果はどちらでもなく、improved群は
 * 基準勝率にすら届かず、全帯・全級で一貫して下回った（回帰が不完全、
 * または「開催序盤にまとまって悪い着順を取る」こと自体がheikin_tokuten/
 * class_rankでは拾いきれない実質的な弱さ・不調の表れである可能性を示唆）。
 * つまり「良化トレンド＝勢いに乗っている」という仮説の方向は明確に否定され、
 * むしろ逆（良化トレンドの選手は次走でも本来の格より勝てていない）という
 * 結果になった。
 * 一方flat群の高勝率は、trend自体の効果というより「2走とも好走できる選手は
 * 元々地力が高い」という選抜効果に見える（flat群のrace[0]平均着順は3.3〜4.3と
 * 元々良好）。declined群はrace[0]平均着順2.5〜3.0（好走からの反落）にもかかわらず
 * 概ね基準勝率と同水準で着地しており、「崩れた選手は次走も苦戦する」という
 * ユーザーの実感（懸念事項）も支持されなかった。
 * Step4（変化幅3+ vs 1-2のバケット）でも同じ傾向: improved3+(13.9%) >
 * improved1-2(12.0%)、declined3+(16.8%) > declined1-2(13.0%)。これは
 * トレンド幅そのものの効果というより、変化幅が大きいほどrace[0]の絶対着順が
 * 極端（1着付近）になりやすいという選抜効果の再確認と解釈できる。
 *
 * ■ 対応
 * 仮説の方向（improved→勝率上昇）は支持されず、むしろ逆方向の一貫した相関
 * だったが、その逆相関もheikin_tokuten/class_rankで説明しきれる交絡・選抜効果
 * （flatの地力選抜、improvedの回帰不完全）の域を出ないと判断した。指示通り
 * 「信号が交絡チェックを生き残り、モメンタムとして本物に見える場合のみ」
 * scoring.ts変更・backtest.tsに進む手順だが、本件はそもそも仮説の向きが
 * 逆転しており「本物のモメンタム信号」としては採用しようがないため、
 * lib/scoring.tsへの変更は行わず、Step5（backtest）は実施しない。
 */

type QueryRow = {
  snum: string;
  encp: string;
  kaisai_date: string;
  race_no: number;
  finish_pos: number;
  heikin_tokuten: number | null;
  class_rank: string | null;
};

type MeetRace = {
  kaisai_date: string;
  race_no: number;
  finish_pos: number;
};

type Rec = {
  snum: string;
  cupId: string;
  trend: number;
  bucket: "improved" | "flat" | "declined";
  win: boolean;
  heikinTokuten: number | null;
  classRank: string | null;
  date: string; // race[2]のkaisai_date（train/test分割・時系列基準）
  firstFinish: number; // race[0]の着順（平均回帰の直接確認用）
};

function rate(recs: Rec[]): string {
  if (recs.length === 0) return "-";
  const w = recs.filter((r) => r.win).length;
  return `${((100 * w) / recs.length).toFixed(1)}%(n=${recs.length})`;
}

function avgFirstFinish(recs: Rec[]): string {
  if (recs.length === 0) return "-";
  const avg = recs.reduce((s, r) => s + r.firstFinish, 0) / recs.length;
  return avg.toFixed(2);
}

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.snum, ra.encp, ra.kaisai_date, ra.race_no, res.finish_pos,
           rc.heikin_tokuten, rc.class_rank
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results res ON res.race_id = ra.id AND res.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE ra.encp LIKE 'wt:%' AND res.finish_pos IS NOT NULL
  `);
  const rows = result.rows as unknown as QueryRow[];
  console.log(`対象出走（wt:接頭、finish_pos非null）: ${rows.length}件`);

  // (snum, cupId) -> レコード一覧（heikin_tokuten/class_rankはracers由来で
  // 同一snum内では不変のため、代表値として最初に見た値を保持しておく）
  const byPair = new Map<string, { races: MeetRace[]; heikinTokuten: number | null; classRank: string | null }>();
  for (const r of rows) {
    const parsed = parseEncp(r.encp);
    if (!parsed) continue;
    const key = `${r.snum}:${parsed.cupId}`;
    let entryForPair = byPair.get(key);
    if (!entryForPair) {
      entryForPair = { races: [], heikinTokuten: r.heikin_tokuten, classRank: r.class_rank };
      byPair.set(key, entryForPair);
    }
    entryForPair.races.push({ kaisai_date: r.kaisai_date, race_no: r.race_no, finish_pos: r.finish_pos });
  }

  let pairsWith2plus = 0;
  let pairsWith3plus = 0;
  const records: Rec[] = [];

  for (const [key, data] of byPair) {
    if (data.races.length >= 2) pairsWith2plus++;
    if (data.races.length < 3) continue;
    pairsWith3plus++;
    const sorted = [...data.races].sort(
      (a, b) => a.kaisai_date.localeCompare(b.kaisai_date) || a.race_no - b.race_no
    );
    const [r0, r1, r2] = sorted; // 最初の3走のみ使用、4走目以降は無視
    const trend = r1.finish_pos - r0.finish_pos;
    const bucket: Rec["bucket"] = trend < 0 ? "improved" : trend > 0 ? "declined" : "flat";
    const [snum] = key.split(":");
    records.push({
      snum,
      cupId: key.split(":")[1],
      trend,
      bucket,
      win: r2.finish_pos === 1,
      heikinTokuten: data.heikinTokuten,
      classRank: data.classRank,
      date: r2.kaisai_date, // trendの算出に使っていないrace[2]の日付を時系列分割の基準に使う
      firstFinish: r0.finish_pos,
    });
  }

  console.log(`(snum, cup_id)組 2走以上: ${pairsWith2plus}件`);
  console.log(`(snum, cup_id)組 3走以上（分析対象）: ${pairsWith3plus}件\n`);

  // 時系列train/test分割（race[2]のkaisai_date基準、最古2/3をtrain）
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  const isTrain = (r: Rec) => r.date < split;
  const isTest = (r: Rec) => r.date >= split;

  console.log(`=== Step1: 生の相関（heikin_tokuten等で層別しない全体） ===`);
  for (const b of ["improved", "flat", "declined"] as const) {
    const recs = records.filter((r) => r.bucket === b);
    console.log(
      `${b.padEnd(9)}: 全体${rate(recs)}  train${rate(recs.filter(isTrain))}  test${rate(recs.filter(isTest))}` +
        `  （race[0]平均着順=${avgFirstFinish(recs)}）`
    );
  }

  // heikin_tokuten三分位（レコード全体の分布から算出）
  const tokutenVals = records
    .map((r) => r.heikinTokuten)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const tercile1Cut = tokutenVals[Math.floor(tokutenVals.length / 3)];
  const tercile2Cut = tokutenVals[Math.floor((tokutenVals.length * 2) / 3)];
  console.log(`\nheikin_tokuten三分位の境界値: 下位<${tercile1Cut.toFixed(1)} / 中位<${tercile2Cut.toFixed(1)} / 上位`);

  function tercileOf(v: number | null): "低位" | "中位" | "高位" | null {
    if (v == null) return null;
    if (v < tercile1Cut) return "低位";
    if (v < tercile2Cut) return "中位";
    return "高位";
  }

  console.log(`\n=== Step2: heikin_tokuten三分位で層別 ===`);
  for (const tier of ["低位", "中位", "高位"] as const) {
    const tierRecs = records.filter((r) => tercileOf(r.heikinTokuten) === tier);
    const baseline = rate(tierRecs); // このtierの「trendを問わない」全体の基準勝率
    console.log(`\n--- ${tier}帯（この帯の基準勝率、trend問わず: ${baseline}） ---`);
    for (const b of ["improved", "flat", "declined"] as const) {
      const recs = tierRecs.filter((r) => r.bucket === b);
      console.log(
        `  ${b.padEnd(9)}: 全体${rate(recs)}  train${rate(recs.filter(isTrain))}  test${rate(recs.filter(isTest))}` +
          `  （race[0]平均着順=${avgFirstFinish(recs)}、この帯全体のrace[0]平均着順=${avgFirstFinish(tierRecs)}）`
      );
    }
  }

  console.log(`\n=== Step3: 平均回帰の直接確認（class_rankでも層別） ===`);
  const ranks = [...new Set(records.map((r) => r.classRank).filter((v): v is string => v != null))];
  for (const rank of ranks) {
    const rankRecs = records.filter((r) => r.classRank === rank);
    if (rankRecs.length < 100) continue; // サンプル数が薄い級班は参考にもならないので出さない
    const baseline = rate(rankRecs);
    const improved = rankRecs.filter((r) => r.bucket === "improved");
    const declined = rankRecs.filter((r) => r.bucket === "declined");
    console.log(
      `${rank.padEnd(3)}: 基準${baseline}  improved${rate(improved)}  declined${rate(declined)}`
    );
  }

  console.log(`\n=== Step4（参考）: 変化幅ベースのバケット ===`);
  function magBucket(trend: number): string {
    if (trend <= -3) return "improved3+";
    if (trend < 0) return "improved1-2";
    if (trend === 0) return "flat";
    if (trend < 3) return "declined1-2";
    return "declined3+";
  }
  const magGroups = new Map<string, Rec[]>();
  for (const r of records) {
    const k = magBucket(r.trend);
    const arr = magGroups.get(k) ?? [];
    arr.push(r);
    magGroups.set(k, arr);
  }
  for (const k of ["improved3+", "improved1-2", "flat", "declined1-2", "declined3+"]) {
    const recs = magGroups.get(k) ?? [];
    console.log(`${k.padEnd(13)}: 全体${rate(recs)}  train${rate(recs.filter(isTrain))}  test${rate(recs.filter(isTest))}`);
  }

  await closeDb();
}

main();
