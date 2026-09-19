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

import { createClient } from "@libsql/client";

/**
 * 【検証結果: 一部採用（信号1・2(nige版)・4は train/test 両方で再現、
 *   信号2b(back_lead版)・信号3はノイズで不採用、信号5はインフィジブル未実施）】
 *
 * 2026-09-19の実売り事故（本命ライン的中＝◎が1着したのに2着が別ラインに
 * さらわれ3連単を外した）を受けての検証。「◎が1着した」条件下で、
 * 2着が同ライン（番手）に収まるか＝ライン決着成功率をどう予測できるか。
 *
 * データ源はTurso（libSQL、10,033レース）。本番のlib/db.tsは支払い問題で
 * Neon(Postgres)に切替済みだがNeonは現在ほぼ空のため、履歴データが残る
 * Turso側に@libsql/clientで直接接続する（lib/db.ts=getDbは使わない）。
 * N+1事故（過去にgetPositionWinRates等の1レースごとのクエリでTursoの
 * 月間読取上限の9倍を消費した事例がある）を避けるため、races/entries+racers/
 * resultsの3クエリのみ一括取得し、以降は全てNode側のメモリ上で集計する。
 * 実測読み取り行数は races 10,033 + entries×racers 71,092 + results 69,891
 * ＝ 合計151,016件（500,000,000行/月の予算の0.03%）。EXPLAIN QUERY PLANで
 * 3クエリとも意図通りの単発全件走査（インデックスの逐次SEARCHはentries→racers
 * のJOIN部分のみ）であることを確認済み。
 *
 * 対象：line_group別に2人以上のラインが存在するレース（女子戦=class_rank
 * "L"始まり・全員単騎戦は除外、8,996件）。予想ライン＝「先頭」の
 * heikin_tokutenが最も高いライン。「◎的中」＝その先頭がfinish_pos=1
 * （3,251件、ベースレート59.8%=1945/3251）。的中レースのうち2着の
 * line_groupが同じか否かがライン決着成功。学習/検証はkaisai_dateの早い
 * 2/3をtrain（分割日20260707、n=2204、ベース60.3%）、残り1/3をtest
 * （n=1047、ベース58.9%）に分割。
 *
 * ■ 結果サマリ（train→test、n=的中かつ2着ライン判定可能な母数）
 *  信号1（本命先頭のkimarite_makuri_count > kimarite_nige_count） :採用。
 *    makuri>nige群はライン決着成功率が明確に低い
 *    （train 55.3%(432/781) vs makuri<=nige 63.5%(885/1394)、差-8.2pt。
 *     test 53.7%(244/454) vs 63.7%(364/571)、差-10.0pt）。
 *    向き・大きさともtrain/testで一致、n十分。捲り屋が1着するとライン決着が
 *    崩れやすいという仮説どおり。
 *  信号2（他ライン先頭のkimarite_nige_count最大値、0/1-3/4+） :採用。
 *    train 0:69.7%(138/198) → 1-3:61.0%(509/834) → 4+:57.2%(628/1097)、
 *    test 0:69.0%(58/84) → 1-3:61.6%(221/359) → 4+:54.6%(316/579)。
 *    低群と高群の差はtrain 12.5pt・test 14.4ptで、単調減少がtrain/test
 *    双方で再現（train/testとも各バケットn>=84）。「他ラインなし」
 *    （不戦状態）は train70.7%/test88.0%とさらに高く方向性と整合するが
 *    testのn=25<30のため参考値扱い。
 *  信号2b（同・back_lead_count最大値、0/1-5/6+） :不採用。train/testとも
 *    1-5バケットが0・6+より高くなる非単調な関係で、仮説どおりの
 *    「低いほど成功率が高い」という順序にならない
 *    （train 0:61.2%(41/67), 1-5:66.8%(308/461), 6+:57.8%(926/1601)、
 *     test 0:55.2%(16/29,n<30), 1-5:68.3%(153/224), 6+:55.4%(426/769)）。
 *    nige_countでは再現した効果がback_lead_countでは再現せず、ノイズと判断。
 *  信号3（本命ラインの先頭がcar_num=1） :不採用。trainでは
 *    car_num=1:64.2%(455/709) vs car_num!=1:58.4%(873/1495)で+5.8ptあるが、
 *    testではcar_num=1:59.0%(191/324) vs car_num!=1:58.9%(426/723)で
 *    +0.1ptとほぼ消滅。trainのみで見えた過学習的な差と判断。
 *  信号4（本命ラインの番手のkimarite_mark_count、0/1-5/6+） :採用（最も
 *    強い信号）。train 0:34.4%(89/259) → 1-5:62.1%(1100/1770) →
 *    6+:79.3%(138/174)、test 0:30.3%(44/145) → 1-5:61.8%(512/828) →
 *    6+:82.4%(61/74)。低群・高群の差はtrain 44.9pt・test 52.1ptと非常に
 *    大きく、単調な向きがtrain/testで完全に一致、n全バケット>=74。
 *  信号5（3番手選手の「3番手時」限定の過去3着内率、leave-one-out的リーク
 *    防止） :インフィジブル（未実施）。日付順の逐次集計＋ライン内位置別
 *    分離が必要で正しく書くには追加の時間が要る。バグを急いで作るより
 *    未着手と明記する方針（下記コード内のログ出力にも明記）。
 */

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

type RaceRow = {
  id: number;
  kaisai_date: string;
  jocd: string;
  keirinjo_name: string;
  race_no: number;
};

type EntryRow = {
  race_id: number;
  car_num: number;
  snum: string;
  line_group: number | null;
  line_position: string | null;
  heikin_tokuten: number | null;
  kyakushitsu: string | null;
  kimarite_nige_count: number | null;
  kimarite_makuri_count: number | null;
  kimarite_sashi_count: number | null;
  kimarite_mark_count: number | null;
  back_lead_count: number | null;
  home_lead_count: number | null;
  class_rank: string | null;
};

type ResultRow = {
  race_id: number;
  car_num: number;
  finish_pos: number | null;
};

function bucketize(rate: number, n: number) {
  return { rate, n };
}

function pct(numer: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((numer / denom) * 100).toFixed(1)}%`;
}

async function main() {
  console.log("=== 1. EXPLAIN QUERY PLAN 確認 ===");
  const plans = await Promise.all([
    client.execute(`EXPLAIN QUERY PLAN SELECT id, kaisai_date, jocd, keirinjo_name, race_no FROM races`),
    client.execute(`EXPLAIN QUERY PLAN
      SELECT e.race_id, e.car_num, e.snum, e.line_group, e.line_position,
             r.heikin_tokuten, r.kyakushitsu, r.kimarite_nige_count, r.kimarite_makuri_count,
             r.kimarite_sashi_count, r.kimarite_mark_count, r.back_lead_count, r.home_lead_count,
             r.class_rank
      FROM entries e JOIN racers r ON r.snum = e.snum`),
    client.execute(`EXPLAIN QUERY PLAN SELECT race_id, car_num, finish_pos FROM results`),
  ]);
  for (const [i, p] of plans.entries()) {
    console.log(`--- plan ${i} ---`);
    for (const row of p.rows) console.log(row);
  }

  console.log("\n=== 2. 一括フェッチ ===");
  const racesRes = await client.execute(`SELECT id, kaisai_date, jocd, keirinjo_name, race_no FROM races`);
  const entriesRes = await client.execute(`
    SELECT e.race_id, e.car_num, e.snum, e.line_group, e.line_position,
           r.heikin_tokuten, r.kyakushitsu, r.kimarite_nige_count, r.kimarite_makuri_count,
           r.kimarite_sashi_count, r.kimarite_mark_count, r.back_lead_count, r.home_lead_count,
           r.class_rank
    FROM entries e JOIN racers r ON r.snum = e.snum
  `);
  const resultsRes = await client.execute(`SELECT race_id, car_num, finish_pos FROM results`);

  const races = racesRes.rows as unknown as RaceRow[];
  const entries = entriesRes.rows as unknown as EntryRow[];
  const results = resultsRes.rows as unknown as ResultRow[];

  const totalRowsRead = races.length + entries.length + results.length;
  console.log(`races: ${races.length}件, entries×racers: ${entries.length}件, results: ${results.length}件`);
  console.log(`実測フェッチ行数合計: ${totalRowsRead}件（Turso無料枠 500,000,000行/月に対する比率: ${((totalRowsRead / 500_000_000) * 100).toFixed(4)}%）`);

  // ---- races: id -> kaisai_date ----
  const raceDate = new Map<number, string>();
  for (const r of races) raceDate.set(r.id, r.kaisai_date);

  // ---- results: race_id:car_num -> finish_pos ----
  const finishPos = new Map<string, number | null>();
  for (const r of results) finishPos.set(`${r.race_id}:${r.car_num}`, r.finish_pos);

  // ---- entries grouped by race_id ----
  const byRace = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const arr = byRace.get(e.race_id) ?? [];
    arr.push(e);
    byRace.set(e.race_id, arr);
  }

  type Analyzed = {
    raceId: number;
    date: string;
    honmeiLineGroup: number;
    senko: EntryRow;
    bantesu: EntryRow | null;
    otherSenkos: EntryRow[];
    honmeiHit: boolean;
    lineFinishSuccess: boolean | null; // null = 的中していないので該当なし
  };

  const analyzed: Analyzed[] = [];
  let skippedGirlsOrSolo = 0;
  let skippedNoLineData = 0;

  for (const [raceId, rows] of byRace) {
    const date = raceDate.get(raceId);
    if (!date) continue;

    // 女子戦（class_rankが"L"始まり）除外
    if (rows.some((r) => r.class_rank && r.class_rank.startsWith("L"))) {
      skippedGirlsOrSolo++;
      continue;
    }

    // line_groupごとにグループ化
    const byLine = new Map<number, EntryRow[]>();
    for (const r of rows) {
      if (r.line_group == null) continue;
      const arr = byLine.get(r.line_group) ?? [];
      arr.push(r);
      byLine.set(r.line_group, arr);
    }

    // 全員単騎（2人以上のラインが1つも無い）は除外
    const multiLines = [...byLine.entries()].filter(([, members]) => members.length >= 2);
    if (multiLines.length === 0) {
      skippedGirlsOrSolo++;
      continue;
    }

    // 各ラインの「先頭」を集める
    const senkoByLine = new Map<number, EntryRow>();
    for (const [lg, members] of multiLines) {
      const senko = members.find((m) => m.line_position === "先頭");
      if (senko && senko.heikin_tokuten != null) senkoByLine.set(lg, senko);
    }
    if (senkoByLine.size === 0) {
      skippedNoLineData++;
      continue;
    }

    // 予想ライン = 先頭のheikin_tokutenが最大のライン
    let honmeiLineGroup: number | null = null;
    let bestTokuten = -Infinity;
    for (const [lg, senko] of senkoByLine) {
      if ((senko.heikin_tokuten ?? -Infinity) > bestTokuten) {
        bestTokuten = senko.heikin_tokuten ?? -Infinity;
        honmeiLineGroup = lg;
      }
    }
    if (honmeiLineGroup == null) continue;

    const honmeiMembers = byLine.get(honmeiLineGroup)!;
    const senko = honmeiMembers.find((m) => m.line_position === "先頭");
    if (!senko) continue;
    const bantesu = honmeiMembers.find((m) => m.line_position === "番手") ?? null;

    const senkoFinish = finishPos.get(`${raceId}:${senko.car_num}`);
    const honmeiHit = senkoFinish === 1;

    let lineFinishSuccess: boolean | null = null;
    if (honmeiHit) {
      // 2着のline_groupを探す
      const secondEntry = rows.find((r) => finishPos.get(`${raceId}:${r.car_num}`) === 2);
      if (secondEntry && secondEntry.line_group != null) {
        lineFinishSuccess = secondEntry.line_group === honmeiLineGroup;
      }
    }

    const otherSenkos = [...senkoByLine.entries()]
      .filter(([lg]) => lg !== honmeiLineGroup)
      .map(([, s]) => s);

    analyzed.push({
      raceId,
      date,
      honmeiLineGroup,
      senko,
      bantesu,
      otherSenkos,
      honmeiHit,
      lineFinishSuccess,
    });
  }

  console.log(`\n集計対象レース: ${analyzed.length}件（除外: 女子戦/全員単騎 ${skippedGirlsOrSolo}件, ライン情報欠落 ${skippedNoLineData}件）`);

  const hitRaces = analyzed.filter((a) => a.honmeiHit && a.lineFinishSuccess !== null);
  console.log(`◎的中かつ2着ライン判定可能: ${hitRaces.length}件`);
  const baseSuccess = hitRaces.filter((a) => a.lineFinishSuccess).length;
  console.log(`ベースレート P(ライン決着成功|◎的中) = ${pct(baseSuccess, hitRaces.length)} (${baseSuccess}/${hitRaces.length})`);

  // ---- train/test split by kaisai_date ----
  const sortedDates = [...new Set(analyzed.map((a) => a.date))].sort();
  const splitIdx = Math.floor(sortedDates.length * (2 / 3));
  const splitDate = sortedDates[splitIdx];
  console.log(`\ntrain/test分割日: ${splitDate}（全${sortedDates.length}開催日中 ${splitIdx}日目、train=それより前、test=以降）`);

  const trainHits = hitRaces.filter((a) => a.date < splitDate);
  const testHits = hitRaces.filter((a) => a.date >= splitDate);
  console.log(`train: ${trainHits.length}件, test: ${testHits.length}件`);
  console.log(
    `  train ベースレート: ${pct(trainHits.filter((a) => a.lineFinishSuccess).length, trainHits.length)} (${trainHits.filter((a) => a.lineFinishSuccess).length}/${trainHits.length})`
  );
  console.log(
    `  test ベースレート: ${pct(testHits.filter((a) => a.lineFinishSuccess).length, testHits.length)} (${testHits.filter((a) => a.lineFinishSuccess).length}/${testHits.length})`
  );

  function report(label: string, buckets: Record<string, Analyzed[]>) {
    console.log(`\n■ ${label}`);
    for (const [name, rows] of Object.entries(buckets)) {
      const succ = rows.filter((a) => a.lineFinishSuccess).length;
      const flag = rows.length < 30 ? " ※n<30 信頼度低い" : "";
      console.log(`  ${name}: ${pct(succ, rows.length)} (${succ}/${rows.length})${flag}`);
    }
  }

  function splitReport(label: string, bucketFn: (a: Analyzed) => string) {
    function makeBuckets(rows: Analyzed[]) {
      const buckets: Record<string, Analyzed[]> = {};
      for (const r of rows) {
        const b = bucketFn(r);
        (buckets[b] ??= []).push(r);
      }
      return buckets;
    }
    report(`${label} [train]`, makeBuckets(trainHits));
    report(`${label} [test]`, makeBuckets(testHits));
  }

  // ---- 信号1: 本命先頭のmakuri > nige ----
  splitReport("信号1: 本命ライン先頭の kimarite_makuri_count vs kimarite_nige_count", (a) => {
    const makuri = a.senko.kimarite_makuri_count ?? 0;
    const nige = a.senko.kimarite_nige_count ?? 0;
    if (makuri === 0 && nige === 0) return "データなし(両0)";
    return makuri > nige ? "makuri>nige" : "makuri<=nige";
  });

  // ---- 信号2: 他ライン先頭のnige/back_lead が低いか ----
  splitReport("信号2: 他ライン先頭の kimarite_nige_count 最大値バケット(0 / 1-3 / 4+)", (a) => {
    if (a.otherSenkos.length === 0) return "他ラインなし";
    const maxNige = Math.max(...a.otherSenkos.map((s) => s.kimarite_nige_count ?? 0));
    if (maxNige === 0) return "0";
    if (maxNige <= 3) return "1-3";
    return "4+";
  });
  splitReport("信号2b: 他ライン先頭の back_lead_count 最大値バケット(0 / 1-5 / 6+)", (a) => {
    if (a.otherSenkos.length === 0) return "他ラインなし";
    const maxBack = Math.max(...a.otherSenkos.map((s) => s.back_lead_count ?? 0));
    if (maxBack === 0) return "0";
    if (maxBack <= 5) return "1-5";
    return "6+";
  });

  // ---- 信号3: 本命ライン先頭のcar_num === 1 ----
  splitReport("信号3: 本命ライン先頭の car_num===1 か", (a) => (a.senko.car_num === 1 ? "car_num=1" : "car_num!=1"));

  // ---- 信号4: 本命ライン番手のkimarite_mark_count ----
  splitReport("信号4: 本命ライン番手の kimarite_mark_count バケット(0 / 1-5 / 6+、番手不在は除外)", (a) => {
    if (!a.bantesu) return "番手不在";
    const mark = a.bantesu.kimarite_mark_count ?? 0;
    if (mark === 0) return "0";
    if (mark <= 5) return "1-5";
    return "6+";
  });

  // ---- 信号5: インフィジブル、未実施 ----
  console.log("\n■ 信号5: 3番手選手の「3番手時」限定の過去3着内率（leave-one-out的リーク防止）");
  console.log("  未実施（インフィジブル扱い）。日付順に各snumの過去出走を逐次集計しライン内位置ごとに");
  console.log("  分離する必要があり、バグを急いで作るリスクが高いため今回はスキップ。");

  console.log("\n=== 完了 ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
