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
 * 【検証結果: 不採用（risk>=2・risk==3のどちらも、母集団全体に適用した場合の
 *   2着的中率・3連単的中率はtrain/testの両方で明確に悪化する。回収率は
 *   train/testで方向が逆転し再現せず、しかも数値自体が数件のブレで大きく
 *   動く不安定な小母数に依存しており信頼できない。ROIが良く見える場合も
 *   悪く見える場合も同じくらい極端で、実運用ルールとして採用できる根拠にはならない）】
 *
 * scripts/diagnose-line-finish-likelihood.tsで見つけた3つの信号（信号1:本命
 * 先頭のmakuri>nige、信号2:他ライン先頭のnige_count最大値>=4、信号4:本命
 * 番手のkimarite_mark_count==0）は「◎的中時に2着が同ラインに収まるか」を
 * 予測できる相関はあるが、それを使って実際の買い目（2着の選び方）を変えたら
 * 的中率・回収率が上がるかは別問題、というのが本スクリプトの検証テーマ。
 * 結論：ならなかった。
 *
 * 母集団はdiagnose-line-finish-likelihood.tsと同じ8,996レース（女子戦・
 * 全員単騎を除外、line_group別に2人以上のラインが存在するレース）のうち、
 * 本命ライン先頭がfinish_pos=1で勝った3,265レース。ここからさらに本命
 * ラインに番手が存在しないレース（ベースフォーメーションが定義できない、
 * 1件のみ）を除外し、検証母集団は3,264件（train 2,214件・test 1,050件、
 * 分割日は前回と同じ20260707を再利用）。
 *
 * ベースフォーメーション（現行）: 1着=本命先頭、2着=本命ライン番手。
 * 代替フォーメーション: 3信号のうち何個が「悪い」条件に該当するか
 * （risk=0-3）を数え、risk>=しきい値なら2着を「他ラインの先頭のうち
 * heikin_tokuten最大」に差し替える（他ラインが無い＝差し替え候補が無い
 * 場合はベースにフォールバック。該当は極少数、下記参照）。しきい値は
 * risk>=2（過半数）とrisk==3（全会一致）の両方を検証。3着は本課題の
 * 主眼ではないため固定ルール（本命ラインの隊列順で未使用の次点選手、
 * いなければ全体でheikin_tokuten最大の未使用選手）。
 *
 * 信号3（mark_count）の条件はまず==0で試行（train 262件・test 146件、
 * 十分な母数）。<=1に広げた場合の参考結果も別途出力しているが、結論は
 * 変わらないため==0を正式な検証条件として採用した。
 *
 * オッズデータの制約（本スクリプトで新たに判明、事前確認）: oddsテーブルは
 * 全レース全通りの3連単オッズを持つフルボードではなく、実際に的中した
 * 組み合わせ1行のみを記録している行がほとんど（9,979レース中8,105レースが
 * 1行のみで、そのcombinationは99.6%のサンプルで実際の着順と一致＝post-race
 * payoutテーブル）。3連単は「予想comboが実際の着順comboと完全一致した時
 * のみ払戻」という性質上、このテーブル構造でも回収率計算に支障はない
 * （不一致ならどのみち払戻0、oddsテーブルに該当行が無い場合も0円扱いで
 * 正しい。的中したのにoddsテーブル欠落だった件数は全ケースで0件だった）。
 * カバレッジはtrain 6573/6589レース(99.8%)・test 3406/3444レース(99.9%)と
 * ほぼ完全。ブロッカーなし。
 *
 * データ源・安全対策はdiagnose-line-finish-likelihood.tsと同じ
 * （Turso直結、races/entries+racers/resultsの3クエリ一括取得＋今回はoddsも
 * 一括取得。1レースごとのクエリループなし。実測167,968件フェッチ＝無料枠
 * 500,000,000行/月の0.034%）。
 *
 * ■ 結果サマリ（母集団全体に適用した場合。100円/点フラット買い、3連単）
 *  ベース    train: 2着的中55.9%(1238/2214) 3連単的中26.5%(584/2200) 回収率295.1%
 *            test : 2着的中54.1%(568/1050)  3連単的中25.8%(269/1043) 回収率264.2%
 *  risk>=2   該当n: train547件/test354件（フォールバック train3件/test2件）
 *            train: 2着的中49.1%(1088/2214,-6.8pt) 3連単22.8%(501/2200,-3.7pt) 回収率271.1%(-24.0pt)
 *            test : 2着的中46.5%(488/1050,-7.6pt)  3連単22.4%(234/1043,-3.4pt) 回収率295.0%(+30.8pt)
 *  risk==3   該当n: train59件/test35件（フォールバック0件/0件）
 *            train: 2着的中55.7%(1233/2214,-0.2pt) 3連単26.3%(578/2200,-0.2pt) 回収率287.9%(-7.2pt)
 *            test : 2着的中54.7%(574/1050,+0.6pt)  3連単26.0%(271/1043,+0.2pt) 回収率293.0%(+28.8pt)
 *
 * 的中率はrisk>=2・risk==3のどちらもtrain/test両方で悪化（risk==3はほぼ
 * 誤差範囲）。回収率はrisk>=2・risk==3ともtrainで悪化・testで改善という
 * 逆転が起き、「train/test両方で改善」という採用条件を満たさない。
 *
 * 差し替えが実際に発生したサブセットだけで見ると理由がわかる：risk>=2の
 * サブセット（train n=544, test n=352）では、差し替えると2着的中率が
 * train45.2%→17.6%・test42.3%→19.6%と大幅に悪化する（＝「ライン決着
 * 失敗」の予測は当たっていても、代わりに「他ライン先頭」が2着に来る
 * という予測は当たっていない。的中率が下がっても稀に的中した時の配当が
 * 高い＝train ROI310.8%→213.0%（悪化）・test ROI230.8%→322.4%（改善）と
 * 真逆に振れる。risk==3のサブセット（train n=59, test n=35）はさらに
 * 極端で、test回収率は67.9%→951.8%という一件の高配当的中に支配された
 * 数値になっており、母数が薄すぎて実運用の根拠にできない。
 *
 * 結論：3つの信号は「ライン決着が崩れる」ことの予測には使えるが、崩れた
 * 時に「どこに崩れるか（＝他ラインの先頭）」までは予測できていない。
 * 回収率の見かけの改善はtestの少数の高配当ヒットに依存した偶然の産物で
 * あり、trainでは同じ方向に出ない。lib/scoring.ts・scripts/compute-picks.ts
 * には反映しない。
 */

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const SPLIT_DATE = "20260707"; // diagnose-line-finish-likelihood.ts と同一の分割日を再利用

type RaceRow = {
  id: number;
  kaisai_date: string;
};

type EntryRow = {
  race_id: number;
  car_num: number;
  snum: string;
  line_group: number | null;
  line_position: string | null;
  heikin_tokuten: number | null;
  kimarite_nige_count: number | null;
  kimarite_makuri_count: number | null;
  kimarite_mark_count: number | null;
  class_rank: string | null;
};

type ResultRow = {
  race_id: number;
  car_num: number;
  finish_pos: number | null;
};

type OddsRow = {
  race_id: number;
  bet_type: string;
  combination: string;
  odds_value: number | null;
};

const LINE_POSITION_RANK: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4 };

function pct(numer: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((numer / denom) * 100).toFixed(1)}%`;
}

function roiPct(payoutYen: number, stakedYen: number): string {
  if (stakedYen === 0) return "n/a";
  return `${((payoutYen / stakedYen) * 100).toFixed(1)}%`;
}

async function main() {
  console.log("=== 1. 一括フェッチ ===");
  const [racesRes, entriesRes, resultsRes, oddsRes] = await Promise.all([
    client.execute(`SELECT id, kaisai_date FROM races`),
    client.execute(`
      SELECT e.race_id, e.car_num, e.snum, e.line_group, e.line_position,
             r.heikin_tokuten, r.kimarite_nige_count, r.kimarite_makuri_count,
             r.kimarite_mark_count, r.class_rank
      FROM entries e JOIN racers r ON r.snum = e.snum
    `),
    client.execute(`SELECT race_id, car_num, finish_pos FROM results`),
    client.execute(`SELECT race_id, bet_type, combination, odds_value FROM odds`),
  ]);

  const races = racesRes.rows as unknown as RaceRow[];
  const entries = entriesRes.rows as unknown as EntryRow[];
  const results = resultsRes.rows as unknown as ResultRow[];
  const odds = oddsRes.rows as unknown as OddsRow[];

  const totalRowsRead = races.length + entries.length + results.length + odds.length;
  console.log(
    `races: ${races.length}件, entries×racers: ${entries.length}件, results: ${results.length}件, odds: ${odds.length}件`
  );
  console.log(
    `実測フェッチ行数合計: ${totalRowsRead}件（Turso無料枠 500,000,000行/月に対する比率: ${(
      (totalRowsRead / 500_000_000) *
      100
    ).toFixed(4)}%）`
  );

  const betTypes = new Set(odds.map((o) => o.bet_type));
  console.log(`odds.bet_type の種類: ${[...betTypes].join(", ")}`);
  const sanrentanOdds = odds.filter((o) => o.bet_type === "3連単");
  const oddsMap = new Map<string, number>();
  for (const o of sanrentanOdds) {
    if (o.odds_value != null) oddsMap.set(`${o.race_id}:${o.combination}`, o.odds_value);
  }

  // ---- races: id -> kaisai_date ----
  const raceDate = new Map<number, string>();
  for (const r of races) raceDate.set(r.id, r.kaisai_date);

  // ---- results grouped by race_id, and finish pos lookup ----
  const finishPos = new Map<string, number | null>();
  const resultsByRace = new Map<number, ResultRow[]>();
  for (const r of results) {
    finishPos.set(`${r.race_id}:${r.car_num}`, r.finish_pos);
    const arr = resultsByRace.get(r.race_id) ?? [];
    arr.push(r);
    resultsByRace.set(r.race_id, arr);
  }

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
    rows: EntryRow[];
    honmeiLineGroup: number;
    honmeiMembers: EntryRow[];
    senko: EntryRow;
    bantesu: EntryRow | null;
    otherSenkos: EntryRow[];
    honmeiHit: boolean;
    actual1: number | null;
    actual2: number | null;
    actual3: number | null;
  };

  const analyzed: Analyzed[] = [];
  let skippedGirlsOrSolo = 0;
  let skippedNoLineData = 0;

  for (const [raceId, rows] of byRace) {
    const date = raceDate.get(raceId);
    if (!date) continue;

    if (rows.some((r) => r.class_rank && r.class_rank.startsWith("L"))) {
      skippedGirlsOrSolo++;
      continue;
    }

    const byLine = new Map<number, EntryRow[]>();
    for (const r of rows) {
      if (r.line_group == null) continue;
      const arr = byLine.get(r.line_group) ?? [];
      arr.push(r);
      byLine.set(r.line_group, arr);
    }

    const multiLines = [...byLine.entries()].filter(([, members]) => members.length >= 2);
    if (multiLines.length === 0) {
      skippedGirlsOrSolo++;
      continue;
    }

    const senkoByLine = new Map<number, EntryRow>();
    for (const [lg, members] of multiLines) {
      const senko = members.find((m) => m.line_position === "先頭");
      if (senko && senko.heikin_tokuten != null) senkoByLine.set(lg, senko);
    }
    if (senkoByLine.size === 0) {
      skippedNoLineData++;
      continue;
    }

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

    const otherSenkos = [...senkoByLine.entries()]
      .filter(([lg]) => lg !== honmeiLineGroup)
      .map(([, s]) => s);

    const raceResults = resultsByRace.get(raceId) ?? [];
    const actual1 = raceResults.find((r) => r.finish_pos === 1)?.car_num ?? null;
    const actual2 = raceResults.find((r) => r.finish_pos === 2)?.car_num ?? null;
    const actual3 = raceResults.find((r) => r.finish_pos === 3)?.car_num ?? null;

    analyzed.push({
      raceId,
      date,
      rows,
      honmeiLineGroup,
      honmeiMembers,
      senko,
      bantesu,
      otherSenkos,
      honmeiHit,
      actual1,
      actual2,
      actual3,
    });
  }

  console.log(
    `\n集計対象レース: ${analyzed.length}件（除外: 女子戦/全員単騎 ${skippedGirlsOrSolo}件, ライン情報欠落 ${skippedNoLineData}件）`
  );

  const honmeiHitRaces = analyzed.filter((a) => a.honmeiHit);
  console.log(`◎的中（本命ライン先頭が1着）: ${honmeiHitRaces.length}件`);

  const noBantesu = honmeiHitRaces.filter((a) => a.bantesu == null);
  const pop = honmeiHitRaces.filter((a) => a.bantesu != null);
  console.log(
    `うち本命ラインに番手が存在しないため除外: ${noBantesu.length}件 → 検証母集団: ${pop.length}件`
  );

  const trainPop = pop.filter((a) => a.date < SPLIT_DATE);
  const testPop = pop.filter((a) => a.date >= SPLIT_DATE);
  console.log(`train: ${trainPop.length}件, test: ${testPop.length}件（分割日 ${SPLIT_DATE}）`);

  // ---- risk条件の計算 ----
  type Risk = {
    a: boolean;
    b: boolean;
    c0: boolean; // mark_count === 0
    c1: boolean; // mark_count <= 1 (widen候補)
    bestOther: EntryRow | null;
  };

  function computeRisk(a: Analyzed): Risk {
    const senko = a.senko;
    const bantesu = a.bantesu!;
    const makuri = senko.kimarite_makuri_count ?? 0;
    const nige = senko.kimarite_nige_count ?? 0;
    const condA = makuri > nige;

    let maxOtherNige: number | null = null;
    if (a.otherSenkos.length > 0) {
      maxOtherNige = Math.max(...a.otherSenkos.map((s) => s.kimarite_nige_count ?? 0));
    }
    const condB = maxOtherNige != null && maxOtherNige >= 4;

    const mark = bantesu.kimarite_mark_count ?? 0;
    const condC0 = mark === 0;
    const condC1 = mark <= 1;

    let bestOther: EntryRow | null = null;
    if (a.otherSenkos.length > 0) {
      bestOther = a.otherSenkos.reduce((best, cur) =>
        (cur.heikin_tokuten ?? -Infinity) > (best.heikin_tokuten ?? -Infinity) ? cur : best
      );
    }

    return { a: condA, b: condB, c0: condC0, c1: condC1, bestOther };
  }

  function riskCount(r: Risk, useC1: boolean): number {
    const c = useC1 ? r.c1 : r.c0;
    return (r.a ? 1 : 0) + (r.b ? 1 : 0) + (c ? 1 : 0);
  }

  // 信号3(mark_count)の条件を0単独/<=1単独でどれだけ母数が変わるか、先に確認する
  const c0CountTrain = trainPop.filter((a) => (a.bantesu!.kimarite_mark_count ?? 0) === 0).length;
  const c0CountTest = testPop.filter((a) => (a.bantesu!.kimarite_mark_count ?? 0) === 0).length;
  const c1CountTrain = trainPop.filter((a) => (a.bantesu!.kimarite_mark_count ?? 0) <= 1).length;
  const c1CountTest = testPop.filter((a) => (a.bantesu!.kimarite_mark_count ?? 0) <= 1).length;
  console.log(
    `\nmark_count==0 単独母数: train ${c0CountTrain}件 / test ${c0CountTest}件` +
      `　mark_count<=1 単独母数: train ${c1CountTrain}件 / test ${c1CountTest}件`
  );

  // ---- 3着の固定ルール ----
  function pickThird(usedCarNums: Set<number>, honmeiMembers: EntryRow[], allEntries: EntryRow[]): EntryRow | null {
    const unusedHonmei = honmeiMembers
      .filter((m) => !usedCarNums.has(m.car_num))
      .sort((x, y) => (LINE_POSITION_RANK[x.line_position ?? ""] ?? 99) - (LINE_POSITION_RANK[y.line_position ?? ""] ?? 99));
    if (unusedHonmei.length > 0) return unusedHonmei[0];

    const unusedAll = allEntries
      .filter((m) => !usedCarNums.has(m.car_num) && m.heikin_tokuten != null)
      .sort((x, y) => (y.heikin_tokuten as number) - (x.heikin_tokuten as number));
    return unusedAll[0] ?? null;
  }

  type StrategyResult = {
    n: number;
    twoBodyHit: number;
    n3: number; // 3着データが揃っているレース数（3連単評価可能な母数）
    threeTanHit: number;
    stakedYen: number;
    payoutYen: number;
    missingOddsOnHit: number; // 的中したがoddsテーブルに該当行が無かった件数（要注意フラグ）
  };

  function evalStrategy(
    rows: Analyzed[],
    secondPicker: (a: Analyzed, risk: Risk) => EntryRow,
    forcedFallbackCounter?: { count: number }
  ): StrategyResult {
    const res: StrategyResult = {
      n: rows.length,
      twoBodyHit: 0,
      n3: 0,
      threeTanHit: 0,
      stakedYen: 0,
      payoutYen: 0,
      missingOddsOnHit: 0,
    };
    for (const a of rows) {
      const risk = computeRisk(a);
      const second = secondPicker(a, risk);
      if (forcedFallbackCounter && risk.bestOther == null) {
        // フォールバック検出はsecondPicker内部の判定に依存するため、
        // ここでは呼び出し側が別途カウントする（下のシミュレーションループ参照）
      }
      const usedForThird = new Set([a.senko.car_num, second.car_num]);
      const third = pickThird(usedForThird, a.honmeiMembers, a.rows);

      if (a.actual2 != null && second.car_num === a.actual2) res.twoBodyHit++;

      if (a.actual2 != null && a.actual3 != null && third != null) {
        res.n3++;
        res.stakedYen += 100;
        const predictedCombo = `${a.senko.car_num}-${second.car_num}-${third.car_num}`;
        const isHit = second.car_num === a.actual2 && third.car_num === a.actual3;
        if (isHit) {
          res.threeTanHit++;
          const oddsValue = oddsMap.get(`${a.raceId}:${predictedCombo}`);
          if (oddsValue == null) {
            res.missingOddsOnHit++;
          } else {
            res.payoutYen += oddsValue * 100;
          }
        }
      }
    }
    return res;
  }

  function baselineSecond(a: Analyzed): EntryRow {
    return a.bantesu!;
  }

  function altSecondFactory(threshold: number, useC1: boolean) {
    return (a: Analyzed, risk: Risk): EntryRow => {
      const rc = riskCount(risk, useC1);
      if (rc >= threshold && risk.bestOther != null) return risk.bestOther;
      return a.bantesu!;
    };
  }

  function countForcedFallback(rows: Analyzed[], threshold: number, useC1: boolean): number {
    let count = 0;
    for (const a of rows) {
      const risk = computeRisk(a);
      const rc = riskCount(risk, useC1);
      if (rc >= threshold && risk.bestOther == null) count++;
    }
    return count;
  }

  function countRiskBucket(rows: Analyzed[], threshold: number, useC1: boolean): number {
    let count = 0;
    for (const a of rows) {
      const risk = computeRisk(a);
      if (riskCount(risk, useC1) >= threshold) count++;
    }
    return count;
  }

  function reportStrategy(label: string, r: StrategyResult) {
    console.log(
      `  ${label}: n=${r.n} / 2着的中率=${pct(r.twoBodyHit, r.n)}(${r.twoBodyHit}/${r.n}) / ` +
        `3連単的中率=${pct(r.threeTanHit, r.n3)}(${r.threeTanHit}/${r.n3}, 3着データ欠落等で評価対象外=${r.n - r.n3}件) / ` +
        `回収率=${roiPct(r.payoutYen, r.stakedYen)}(payout=${r.payoutYen.toFixed(0)}円/staked=${r.stakedYen}円)` +
        `${r.missingOddsOnHit > 0 ? ` ※的中したがoddsテーブル欠落=${r.missingOddsOnHit}件（回収率計算では0円扱い）` : ""}`
    );
  }

  function runSplit(label: string, rows: Analyzed[], useC1: boolean) {
    console.log(`\n■ ${label}（n=${rows.length}）`);
    const baseline = evalStrategy(rows, baselineSecond);
    reportStrategy("ベース（常に番手を2着）", baseline);

    for (const threshold of [2, 3]) {
      const riskN = countRiskBucket(rows, threshold, useC1);
      const fallbackN = countForcedFallback(rows, threshold, useC1);
      console.log(
        `  [risk>=${threshold}] 該当レース数=${riskN}件${riskN < 30 ? " ※n<30 信頼度低い" : ""}` +
          `（うち他ライン無しで差し替え不能=フォールバック=${fallbackN}件）`
      );
      const alt = evalStrategy(rows, altSecondFactory(threshold, useC1));
      reportStrategy(`代替（risk>=${threshold}で他ライン先頭に差し替え）`, alt);
    }
  }

  console.log("\n=== 2. mark_count==0 (信号3の当初条件) での検証 ===");
  runSplit("train", trainPop, false);
  runSplit("test", testPop, false);

  console.log(
    "\n=== 3. 参考: mark_count<=1 に広げた場合（==0で母数不足の場合の代替。上の結果と比較用） ==="
  );
  runSplit("train", trainPop, true);
  runSplit("test", testPop, true);

  // ---- risk条件が実際に「差し替えを起こした」サブセットに限定した内訳（補足） ----
  function runSwitchedSubsetOnly(label: string, rows: Analyzed[], threshold: number, useC1: boolean) {
    const switched = rows.filter((a) => {
      const risk = computeRisk(a);
      return riskCount(risk, useC1) >= threshold && risk.bestOther != null;
    });
    console.log(`\n▲ ${label} risk>=${threshold} かつ実際に差し替え発生した母数のみ（n=${switched.length}${switched.length < 30 ? " ※n<30" : ""}）`);
    if (switched.length === 0) {
      console.log("  該当レースなし");
      return;
    }
    const baseline = evalStrategy(switched, baselineSecond);
    reportStrategy("  同レース群でベースのままだった場合", baseline);
    const alt = evalStrategy(switched, altSecondFactory(threshold, useC1));
    reportStrategy("  同レース群で実際に差し替えた場合", alt);
  }

  console.log("\n=== 4. 補足: 差し替えが実際に発生したサブセットだけでの比較（mark_count==0版） ===");
  for (const threshold of [2, 3]) {
    runSwitchedSubsetOnly("train", trainPop, threshold, false);
    runSwitchedSubsetOnly("test", testPop, threshold, false);
  }

  console.log("\n=== 完了 ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
