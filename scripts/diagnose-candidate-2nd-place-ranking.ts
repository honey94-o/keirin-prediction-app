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
 * 【検証結果: 部分採用（ランキング手法自体はtrain/test両方で明確に有効だが、
 *   risk flagベースの実戦略に組み込んでも現行ベース（常に番手を2着）を上回れず
 *   不採用。lib/scoring.ts・scripts/compute-picks.tsには反映しない）】
 *
 * scripts/diagnose-line-finish-strategy-sim.ts（fcfe501）の結論「信号1/2/4の
 * risk flagは"ライン決着が崩れる"ことは予測できるが"どこに崩れるか"は当てられて
 * いない（差し替え後の2着的中率が45%→18-20%に崩壊）」を受けた次の一手。今回は
 * レース単位のyes/no信号ではなく、「ライン決着が実際に失敗したレースに限定して、
 * 2着に来た具体的な選手を、非本命ラインの候補者間の個人特性でランキングできるか」
 * という粒度の細かい問いを検証した。
 *
 * ■ 母集団（診断1と同じ8,996レースから再構築、丸めず正確に再計算）
 * ◎的中かつ2着ライン判定可能 3,251件のうち、ライン決着失敗（2着が別ライン）は
 * 1,306件（1,306/3,251=40.2%、診断1のベースレート59.8%の残り）。候補プールが
 * 2人以上（順位付けに意味がある）かつ2着選手データ有りの1,306件全件が対象。
 * train 876件・test 430件（分割日20260707、診断1/2と同一）。平均候補プール
 * サイズ train4.46人/test4.57人。候補プール定義：本命ライン以外の全選手
 * （他ラインの先頭/番手/3番手 + 単騎選手。line_group !== 本命line_groupで判定、
 * 本命ライン自身の番手/3番手は定義上2着になり得ないため除外）。
 *
 * ■ top-1正解率（実際の2着選手と一致した割合、train→test）
 *  (a)ランダム期待値                          : 23.4% → 22.7%
 *  (b)候補プール全体でheikin_tokuten最大       : 46.5%(407/876) → 43.7%(188/430)
 *  (c)script2が実際に使ったルール
 *     （他ライン"先頭"限定でheikin_tokuten最大）: 36.8%(314/854) → 34.9%(149/427)
 *     （母数は他ライン先頭が存在するレースのみ。存在しない22件/3件は
 *      script2ルールでは差し替え候補ゼロ＝的中しようがない）
 *  単一特徴量のみ（候補プール全体、heikin_tokuten以外）:
 *     kimarite_nige_count最大   : 36.4% → 30.2%
 *     kimarite_makuri_count最大 : 38.8% → 35.3%
 *     kimarite_sashi_count最大  : 35.3% → 30.9%
 *     → いずれもheikin_tokutenに明確に劣る。
 *  脚質×先頭ポジションの絞り込み/優先（案A:先頭×逃両限定、案B:先頭限定、
 *  案C:先頭×逃両を優先グループ化）:
 *     案A: 38.8% → 34.9%　案B: 39.3% → 36.0%　案C: 38.8% → 34.9%
 *     （top2は案Cが62.2%/57.0%と単一先頭限定より良いが、(b)の72.8%/69.3%には
 *      届かない）→ 番手まくり知見（先頭以外にも実力があれば来る）と整合し、
 *     先頭ポジションに絞る/優先することはこの問いではむしろ情報を捨てて悪化
 *     させる。3番手・単騎・他ラインの番手も普通に2着候補になっている。
 *  組み合わせスコア（z-score化、重みはtrainのみで選定）: heikin_tokutenに
 *     kimarite_nige_count/kimarite_makuri_countを足すあらゆる重み
 *     （0.3/0.5/-0.3等）はtrain top1を単独heikin_tokutenの46.5%から悪化させた
 *     （最良でも44.4%）→ 組み合わせが単一特徴量を上回る場面が無く、要件通り
 *     複合スコアは不採用。testでの確定評価もheikin_tokuten単独と同じ43.7%。
 *
 * → 結論：(b)「候補プール全体（他ラインの先頭/番手/3番手+単騎を区別せず）で
 * heikin_tokuten最大」が、train+9.7pt・test+8.8ptとscript2の実装（他ライン
 * 先頭限定）を train/test 両方で明確に上回った。ランダム比でも2倍前後の
 * 情報量がある。この方向性が唯一「クリアかつ一貫した改善」の条件を満たしたため、
 * 戦略シミュレーションに進んだ。
 *
 * ■ 戦略シミュレーション（diagnose-line-finish-strategy-sim.tsの方法を完全再現、
 *   母集団も同一：◎的中かつ本命ラインに番手ありの3,264件、train2,214件・
 *   test1,050件。100円/点フラット買い・3連単。risk flag=信号1/2/4のうち
 *   いくつが「悪い」条件に該当するか(0-3)、risk>=しきい値で2着を差し替え）
 *   ベースライン再現値はscript2の報告値と完全一致（検算OK）:
 *   ベース train: 2着的中55.9%(1238/2214) 3連単26.5%(584/2200) 回収率295.1%
 *          test : 2着的中54.1%(568/1050)  3連単25.8%(269/1043) 回収率264.2%
 *
 *   risk>=2（該当train547件/test354件）:
 *    (a)script2版（他ライン先頭のみ）: train 2着49.1%(-6.8pt) 3連単22.8%(-3.7pt)
 *       回収率271.1%(-24.0pt) / test 2着46.5%(-7.6pt) 3連単22.4%(-3.4pt)
 *       回収率295.0%(+30.8pt) ※script2の報告値と完全一致
 *    (b)新ランキング版（候補プール全体）: train 2着50.4%(1116/2214,-5.5pt)
 *       3連単23.1%(509/2200,-3.4pt) 回収率280.1%(-15.0pt) / test 2着
 *       47.8%(502/1050,-6.3pt) 3連単23.0%(240/1043,-2.8pt)
 *       回収率323.7%(+59.5pt)
 *    → (b)は(a)を train/test 全指標で一貫して上回る（script2の実装より
 *    確実に良い差し替えルール）。しかし現行ベース（常に番手）と比べると
 *    2着的中率はtrain/testとも依然マイナス（-5.5pt/-6.3pt）で、回収率は
 *    train悪化・test改善と方向が割れる、script2と同型の再現不能パターン。
 *    「train/test両方でベースを上回る」という採用条件を満たさない。
 *
 *   risk>=3（該当train59件/test35件、n薄め）: (a)(b)ともベースとの差は
 *    ±1pt未満に収束（差し替え対象が59件/35件と少ないため）。testの回収率
 *    だけ(b)294.6%→(b)306.0%と上振れて見えるが、下記の差し替えサブセット
 *    単体の内訳（test n=35、回収率67.9%→1350.6%）が示す通り数件の高配当
 *    的中に支配された値で、母数薄く実運用の根拠にならない（script2の
 *    risk==3所見と同じ結論）。
 *
 *   差し替えが実際に発生したサブセットのみ（新ランキング版）:
 *    risk>=2: train n=547 ベースのまま45.0%(246/547)→差し替え後22.7%(124/547)、
 *      test n=354 ベースのまま42.1%(149/354)→差し替え後23.4%(83/354)。
 *      診断本体で見た「line-finish失敗確定後」のtop1正解率46.5%/43.7%より
 *      遥かに低い22.7%/23.4%に落ちる理由: risk flag自体が「失敗確定」の
 *      完全な代理ではなく、flag発火レースの中にはライン決着が実際には
 *      成功したケース（＝差し替えれば必ず外れる）も混ざっているため。
 *      優れた候補ランキングを当てても、母集団の選別（risk flag）が粗いままでは
 *      戦略全体としては損失を防げない。
 *
 * ■ 総合結論：候補選手ランキング自体（heikin_tokuten最大、候補プール全体対象）
 * は「ライン決着失敗が確定した状況で誰が2着に来るか」を予測する real な信号で、
 * script2のナイーブルールより明確に優れている——ここは新しい確認事項として
 * 記録に値する。しかしscript2と同じrisk-flagベースの実戦略に組み込むと、
 * 現行ベース（常に番手を2着に固定）を上回るには至らない：2着的中率は
 * train/testとも悪化したまま、回収率はtrain/testで方向が逆転する。
 * 根本原因はscript2の時と同じ階層で再発している——優れた候補選択があっても、
 * 「いつ差し替えるべきか」を決める risk flag 自体の粗さ（成功ケースを誤って
 * 拾ってしまう）がボトルネックである。lib/scoring.ts・scripts/compute-picks.ts
 * への反映は見送り。
 *
 * データ源・安全対策は診断1/2と同じ（Turso直結、races/entries+racers/results/
 * oddsの4クエリを一括取得のみ、predictRaceや1レースごとのクエリループは無し。
 * 実測167,968件フェッチ＝無料枠500,000,000行/月の0.034%）。
 */

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const SPLIT_DATE = "20260707"; // 既存2スクリプトと同一の分割日を再利用

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

function flag(n: number): string {
  return n < 30 ? " ※n<30 信頼度低い" : "";
}

async function main() {
  console.log("=== 1. 一括フェッチ ===");
  const [racesRes, entriesRes, resultsRes, oddsRes] = await Promise.all([
    client.execute(`SELECT id, kaisai_date FROM races`),
    client.execute(`
      SELECT e.race_id, e.car_num, e.snum, e.line_group, e.line_position,
             r.heikin_tokuten, r.kyakushitsu, r.kimarite_nige_count, r.kimarite_makuri_count,
             r.kimarite_sashi_count, r.kimarite_mark_count, r.back_lead_count, r.home_lead_count,
             r.class_rank
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

  const sanrentanOdds = odds.filter((o) => o.bet_type === "3連単");
  const oddsMap = new Map<string, number>();
  for (const o of sanrentanOdds) {
    if (o.odds_value != null) oddsMap.set(`${o.race_id}:${o.combination}`, o.odds_value);
  }

  const raceDate = new Map<number, string>();
  for (const r of races) raceDate.set(r.id, r.kaisai_date);

  const finishPos = new Map<string, number | null>();
  const resultsByRace = new Map<number, ResultRow[]>();
  for (const r of results) {
    finishPos.set(`${r.race_id}:${r.car_num}`, r.finish_pos);
    const arr = resultsByRace.get(r.race_id) ?? [];
    arr.push(r);
    resultsByRace.set(r.race_id, arr);
  }

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
    lineFinishSuccess: boolean | null;
    actual1: number | null;
    actual2: number | null;
    actual3: number | null;
    actual2Entry: EntryRow | null;
    candidates: EntryRow[]; // 非本命ラインの全選手（線finish失敗時の2着候補プール）
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

    let lineFinishSuccess: boolean | null = null;
    let actual2Entry: EntryRow | null = null;
    if (honmeiHit) {
      const secondEntry = rows.find((r) => finishPos.get(`${raceId}:${r.car_num}`) === 2) ?? null;
      actual2Entry = secondEntry;
      if (secondEntry && secondEntry.line_group != null) {
        lineFinishSuccess = secondEntry.line_group === honmeiLineGroup;
      }
    }

    const otherSenkos = [...senkoByLine.entries()]
      .filter(([lg]) => lg !== honmeiLineGroup)
      .map(([, s]) => s);

    const raceResults = resultsByRace.get(raceId) ?? [];
    const actual1 = raceResults.find((r) => r.finish_pos === 1)?.car_num ?? null;
    const actual2 = raceResults.find((r) => r.finish_pos === 2)?.car_num ?? null;
    const actual3 = raceResults.find((r) => r.finish_pos === 3)?.car_num ?? null;

    // 候補プール = 本命ライン以外の全選手（他ライン先頭/番手/3番手 + 単騎選手）
    const candidates = rows.filter((r) => r.line_group !== honmeiLineGroup);

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
      lineFinishSuccess,
      actual1,
      actual2,
      actual3,
      actual2Entry,
      candidates,
    });
  }

  console.log(
    `\n集計対象レース: ${analyzed.length}件（除外: 女子戦/全員単騎 ${skippedGirlsOrSolo}件, ライン情報欠落 ${skippedNoLineData}件）`
  );

  const honmeiHitRaces = analyzed.filter((a) => a.honmeiHit && a.lineFinishSuccess !== null);
  console.log(`◎的中かつ2着ライン判定可能: ${honmeiHitRaces.length}件`);

  // ---- 本タスクの母集団: ◎的中 かつ ライン決着「失敗」（2着が別ライン） ----
  const failRaces = honmeiHitRaces.filter((a) => a.lineFinishSuccess === false);
  console.log(`このうちライン決着失敗（2着が別ライン）: ${failRaces.length}件`);

  // actual2Entryが必ず候補プールに含まれているはず（別ラインなので）。念のため検証。
  const badActual2 = failRaces.filter(
    (a) => a.actual2Entry == null || !a.candidates.some((c) => c.car_num === a.actual2Entry!.car_num)
  );
  if (badActual2.length > 0) {
    console.log(`  警告: actual2Entryが候補プールに見つからないレースが${badActual2.length}件ある`);
  }

  // 候補プールが1人以下（差し替え不能）のレースは「予測」しようがないので除外
  const pop = failRaces.filter((a) => a.candidates.length >= 2 && a.actual2Entry != null);
  console.log(
    `候補プール2人以上（=順位付けに意味がある）かつ2着選手データ有り: ${pop.length}件（除外: 候補1人以下または2着データ欠落 ${failRaces.length - pop.length}件）`
  );

  const trainPop = pop.filter((a) => a.date < SPLIT_DATE);
  const testPop = pop.filter((a) => a.date >= SPLIT_DATE);
  console.log(`train: ${trainPop.length}件, test: ${testPop.length}件（分割日 ${SPLIT_DATE}）`);

  const avgPoolSizeTrain = trainPop.reduce((s, a) => s + a.candidates.length, 0) / trainPop.length;
  const avgPoolSizeTest = testPop.reduce((s, a) => s + a.candidates.length, 0) / testPop.length;
  console.log(
    `平均候補プールサイズ: train ${avgPoolSizeTrain.toFixed(2)}人, test ${avgPoolSizeTest.toFixed(2)}人`
  );

  // ============================================================
  // ランキング手法の評価: top-1 (top-2参考) 正解率
  // ============================================================

  type RankMethod = {
    label: string;
    // 候補配列を「1位が最有力」の順に並べ替えて返す（同点はheikin_tokuten降順→car_num昇順で安定化）
    rank: (candidates: EntryRow[]) => EntryRow[];
  };

  function stableSecondarySort(cands: EntryRow[]): EntryRow[] {
    return [...cands].sort((x, y) => {
      const hx = x.heikin_tokuten ?? -Infinity;
      const hy = y.heikin_tokuten ?? -Infinity;
      if (hy !== hx) return hy - hx;
      return x.car_num - y.car_num;
    });
  }

  function sortByKeyDesc(cands: EntryRow[], keyFn: (e: EntryRow) => number): EntryRow[] {
    // 主キーで降順ソートし、同値はheikin_tokuten降順→car_num昇順で安定タイブレーク
    const withKey = cands.map((c) => ({ c, k: keyFn(c) }));
    withKey.sort((x, y) => {
      if (y.k !== x.k) return y.k - x.k;
      const hx = x.c.heikin_tokuten ?? -Infinity;
      const hy = y.c.heikin_tokuten ?? -Infinity;
      if (hy !== hx) return hy - hx;
      return x.c.car_num - y.c.car_num;
    });
    return withKey.map((w) => w.c);
  }

  type EvalResult = { n: number; top1: number; top2: number };

  function evalMethod(rows: Analyzed[], rank: (a: Analyzed) => EntryRow[]): EvalResult {
    let top1 = 0;
    let top2 = 0;
    for (const a of rows) {
      const ranked = rank(a);
      const idx = ranked.findIndex((c) => c.car_num === a.actual2Entry!.car_num);
      if (idx === 0) top1++;
      if (idx >= 0 && idx <= 1) top2++;
    }
    return { n: rows.length, top1, top2 };
  }

  function reportEval(label: string, r: EvalResult) {
    console.log(
      `  ${label}: top1=${pct(r.top1, r.n)}(${r.top1}/${r.n}) top2=${pct(r.top2, r.n)}(${r.top2}/${r.n})${flag(r.n)}`
    );
  }

  function runAllMethods(label: string, rows: Analyzed[], methods: { name: string; rank: (a: Analyzed) => EntryRow[] }[]) {
    console.log(`\n■ ${label}（母数 n=${rows.length}）`);
    for (const m of methods) {
      reportEval(m.name, evalMethod(rows, m.rank));
    }
  }

  // ---- ナイーブ基準 (a): ランダム選択の期待正解率 = 1/poolSize の平均 ----
  function randomExpectedTop1(rows: Analyzed[]): { expected: number; n: number } {
    if (rows.length === 0) return { expected: 0, n: 0 };
    const sum = rows.reduce((s, a) => s + 1 / a.candidates.length, 0);
    return { expected: sum / rows.length, n: rows.length };
  }

  // ---- ナイーブ基準 (c): script2が実際に使った「他ライン先頭のうちheikin_tokuten最大」----
  // script2のbestOtherは a.otherSenkos（各ラインのline_position==="先頭"のみ）から選ぶ。
  // 候補プール全体（番手・3番手・単騎も含む）ではなく「他ライン先頭」限定である点を厳密に再現する。
  function script2BestOtherSenko(a: Analyzed): EntryRow | null {
    if (a.otherSenkos.length === 0) return null;
    return a.otherSenkos.reduce((best, cur) =>
      (cur.heikin_tokuten ?? -Infinity) > (best.heikin_tokuten ?? -Infinity) ? cur : best
    );
  }

  console.log("\n=== 2. ナイーブ基準 ===");
  for (const [label, rows] of [
    ["train", trainPop],
    ["test", testPop],
  ] as const) {
    const rnd = randomExpectedTop1(rows);
    console.log(`  ${label} (a)ランダム期待正解率: ${(rnd.expected * 100).toFixed(1)}% (n=${rnd.n})`);

    const bTokuten = evalMethod(rows, (a) => sortByKeyDesc(a.candidates, (c) => c.heikin_tokuten ?? -Infinity));
    console.log(
      `  ${label} (b)候補プール全体でheikin_tokuten最大: top1=${pct(bTokuten.top1, bTokuten.n)}(${bTokuten.top1}/${bTokuten.n}) top2=${pct(bTokuten.top2, bTokuten.n)}(${bTokuten.top2}/${bTokuten.n})`
    );

    // script2の「他ライン先頭のみ」ルールはotherSenkosが空のレースでは差し替え不能（フォールバック）だった。
    // ここではapples-to-apples比較のため、他ライン先頭が候補プール内に存在する場合のみを母数とする。
    const withOtherSenko = rows.filter((a) => script2BestOtherSenko(a) != null);
    let top1c = 0;
    let top2c = 0;
    for (const a of withOtherSenko) {
      const pick = script2BestOtherSenko(a)!;
      // script2のルールは「1人だけ選ぶ」ロジックなので、top2はそのまま「1位のみ」に折り込み、
      // 参考としてscript2ルールでは2位相当が定義されないため top2=top1 として扱う
      if (pick.car_num === a.actual2Entry!.car_num) {
        top1c++;
        top2c++;
      }
    }
    console.log(
      `  ${label} (c)script2実際のルール(他ライン先頭のみ・heikin_tokuten最大): top1=${pct(top1c, withOtherSenko.length)}(${top1c}/${withOtherSenko.length}) （母数=他ライン先頭が存在するレースのみ、全体n=${rows.length}中${withOtherSenko.length}件）`
    );
  }

  // ============================================================
  // 3. 単一特徴量ランキング（候補プール全体が対象）
  // ============================================================
  const singleFeatureMethods = [
    { name: "heikin_tokuten最大", rank: (a: Analyzed) => sortByKeyDesc(a.candidates, (c) => c.heikin_tokuten ?? -Infinity) },
    { name: "kimarite_nige_count最大", rank: (a: Analyzed) => sortByKeyDesc(a.candidates, (c) => c.kimarite_nige_count ?? -Infinity) },
    { name: "kimarite_makuri_count最大", rank: (a: Analyzed) => sortByKeyDesc(a.candidates, (c) => c.kimarite_makuri_count ?? -Infinity) },
    { name: "kimarite_sashi_count最大", rank: (a: Analyzed) => sortByKeyDesc(a.candidates, (c) => c.kimarite_sashi_count ?? -Infinity) },
  ];

  console.log("\n=== 3. 単一特徴量ランキング（候補プール全体） ===");
  runAllMethods("train", trainPop, singleFeatureMethods);
  runAllMethods("test", testPop, singleFeatureMethods);

  // ============================================================
  // 4. 脚質×先頭ポジションの絞り込み/優先
  // ============================================================
  // 案A: 先頭ポジション かつ 逃/両 のみを対象にheikin_tokuten最大（該当者がいなければ候補プール全体にフォールバック）
  function senkoNigeRyoRank(a: Analyzed): EntryRow[] {
    const restricted = a.candidates.filter(
      (c) => c.line_position === "先頭" && (c.kyakushitsu === "逃" || c.kyakushitsu === "両")
    );
    const base = restricted.length > 0 ? restricted : a.candidates;
    return sortByKeyDesc(base, (c) => c.heikin_tokuten ?? -Infinity);
  }
  // 案B: 先頭ポジションのみ（脚質問わず）heikin_tokuten最大、いなければ全体
  function senkoOnlyRank(a: Analyzed): EntryRow[] {
    const restricted = a.candidates.filter((c) => c.line_position === "先頭");
    const base = restricted.length > 0 ? restricted : a.candidates;
    return sortByKeyDesc(base, (c) => c.heikin_tokuten ?? -Infinity);
  }
  // 案C: 優先度ソート（先頭×逃/両 を最優先グループにしつつ、グループ内heikin_tokuten降順、
  // その後は残り全員をheikin_tokuten降順で続ける＝top2にも効くようフォールバックでなく優先度並べ替え）
  function senkoNigeRyoPriorityRank(a: Analyzed): EntryRow[] {
    const priority = (c: EntryRow) => (c.line_position === "先頭" && (c.kyakushitsu === "逃" || c.kyakushitsu === "両") ? 0 : 1);
    const withKey = a.candidates.map((c) => ({ c, p: priority(c), h: c.heikin_tokuten ?? -Infinity }));
    withKey.sort((x, y) => {
      if (x.p !== y.p) return x.p - y.p;
      if (y.h !== x.h) return y.h - x.h;
      return x.c.car_num - y.c.car_num;
    });
    return withKey.map((w) => w.c);
  }

  const kyakushitsuMethods = [
    { name: "案A: 先頭×逃/両限定→heikin_tokuten最大(該当無し時は全体フォールバック)", rank: senkoNigeRyoRank },
    { name: "案B: 先頭限定(脚質問わず)→heikin_tokuten最大(該当無し時は全体フォールバック)", rank: senkoOnlyRank },
    { name: "案C: 先頭×逃/両を優先グループ化した並べ替え（全員に順位付与）", rank: senkoNigeRyoPriorityRank },
  ];

  console.log("\n=== 4. 脚質×先頭ポジションの絞り込み/優先 ===");
  runAllMethods("train", trainPop, kyakushitsuMethods);
  runAllMethods("test", testPop, kyakushitsuMethods);

  // ============================================================
  // 5. 組み合わせスコア（trainのみで重み決定 → testで評価）
  // ============================================================
  // z-score化のための平均・標準偏差をtrainの候補プール全体から計算
  function meanStd(values: number[]): { mean: number; std: number } {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(variance) };
  }

  const trainCandidatesFlat = trainPop.flatMap((a) => a.candidates);
  const tokutenStats = meanStd(trainCandidatesFlat.map((c) => c.heikin_tokuten ?? 0));
  const nigeStats = meanStd(trainCandidatesFlat.map((c) => c.kimarite_nige_count ?? 0));
  const makuriStats = meanStd(trainCandidatesFlat.map((c) => c.kimarite_makuri_count ?? 0));
  console.log(
    `\ntrain候補プールの統計量: heikin_tokuten 平均${tokutenStats.mean.toFixed(2)}/標準偏差${tokutenStats.std.toFixed(2)}、` +
      `nige_count 平均${nigeStats.mean.toFixed(2)}/標準偏差${nigeStats.std.toFixed(2)}、` +
      `makuri_count 平均${makuriStats.mean.toFixed(2)}/標準偏差${makuriStats.std.toFixed(2)}`
  );

  function zTokuten(v: number | null): number {
    return tokutenStats.std === 0 ? 0 : ((v ?? tokutenStats.mean) - tokutenStats.mean) / tokutenStats.std;
  }
  function zNige(v: number | null): number {
    return nigeStats.std === 0 ? 0 : ((v ?? nigeStats.mean) - nigeStats.mean) / nigeStats.std;
  }
  function zMakuri(v: number | null): number {
    return makuriStats.std === 0 ? 0 : ((v ?? makuriStats.mean) - makuriStats.mean) / makuriStats.std;
  }

  // 重み候補をtrainのtop1正解率だけで選ぶ（testは一切見ない）。
  // 単一特徴量の結果（セクション3）でheikin_tokutenが最有力になることが多い過去の傾向を踏まえ、
  // heikin_tokutenを主軸に、決め手カウント(nige/makuri)を副次項として混ぜる小さな探索。
  const weightCandidates: { name: string; w: { tokuten: number; nige: number; makuri: number } }[] = [
    { name: "w=(1,0,0)=heikin_tokutenのみ", w: { tokuten: 1, nige: 0, makuri: 0 } },
    { name: "w=(1,0.3,0)", w: { tokuten: 1, nige: 0.3, makuri: 0 } },
    { name: "w=(1,0.5,0)", w: { tokuten: 1, nige: 0.5, makuri: 0 } },
    { name: "w=(1,0.3,-0.3)", w: { tokuten: 1, nige: 0.3, makuri: -0.3 } },
    { name: "w=(0.7,0.3,0)", w: { tokuten: 0.7, nige: 0.3, makuri: 0 } },
  ];

  function combinedRank(w: { tokuten: number; nige: number; makuri: number }) {
    return (a: Analyzed) =>
      sortByKeyDesc(
        a.candidates,
        (c) => w.tokuten * zTokuten(c.heikin_tokuten) + w.nige * zNige(c.kimarite_nige_count) + w.makuri * zMakuri(c.kimarite_makuri_count)
      );
  }

  console.log("\n=== 5. 組み合わせスコア: 重み探索はtrainのみで実施 ===");
  let bestWeightName = weightCandidates[0].name;
  let bestWeightW = weightCandidates[0].w;
  let bestTrainTop1 = -1;
  for (const wc of weightCandidates) {
    const r = evalMethod(trainPop, combinedRank(wc.w));
    console.log(`  [train探索用] ${wc.name}: top1=${pct(r.top1, r.n)}(${r.top1}/${r.n})`);
    if (r.top1 / r.n > bestTrainTop1) {
      bestTrainTop1 = r.top1 / r.n;
      bestWeightName = wc.name;
      bestWeightW = wc.w;
    }
  }
  console.log(`  → train最良: ${bestWeightName}（この重みだけをtestで評価する）`);

  console.log("\n  [確定評価] 選定した重みでtrain/test評価:");
  reportEval(`train: ${bestWeightName}`, evalMethod(trainPop, combinedRank(bestWeightW)));
  reportEval(`test : ${bestWeightName}`, evalMethod(testPop, combinedRank(bestWeightW)));

  console.log("\n=== 完了（ランキング評価パート） ===");

  // ============================================================
  // 6. 戦略シミュレーション（セクション2-5の結論を受けて実施）
  //    候補プール全体でheikin_tokuten最大が、script2のナイーブルール（他ライン
  //    先頭限定）をtrain/test両方で明確に上回ったため、diagnose-line-finish-
  //    strategy-sim.tsの検証をそのまま再現し、差し替え先だけを新ルールに
  //    変えた場合に的中率・回収率が改善するかを見る。
  // ============================================================
  console.log("\n\n=== 6. 戦略シミュレーション: risk flag発火時の2着差し替え（script2ベース vs 新ランキング版） ===");

  const stratPop = analyzed.filter((a) => a.honmeiHit && a.bantesu != null);
  const stratTrain = stratPop.filter((a) => a.date < SPLIT_DATE);
  const stratTest = stratPop.filter((a) => a.date >= SPLIT_DATE);
  console.log(`母集団（◎的中かつ本命ラインに番手あり）: 全体${stratPop.length}件 train${stratTrain.length}件 test${stratTest.length}件`);

  type Risk = { a: boolean; b: boolean; c: boolean; bestOtherSenko: EntryRow | null; bestOtherCandidate: EntryRow | null };

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
    const condC = mark === 0;

    // script2のナイーブ差し替え候補: 他ライン「先頭」限定でheikin_tokuten最大
    let bestOtherSenko: EntryRow | null = null;
    if (a.otherSenkos.length > 0) {
      bestOtherSenko = a.otherSenkos.reduce((best, cur) =>
        (cur.heikin_tokuten ?? -Infinity) > (best.heikin_tokuten ?? -Infinity) ? cur : best
      );
    }

    // 本診断で見つかった新ルール: 本命ライン以外の候補プール全体でheikin_tokuten最大
    let bestOtherCandidate: EntryRow | null = null;
    if (a.candidates.length > 0) {
      bestOtherCandidate = a.candidates.reduce((best, cur) =>
        (cur.heikin_tokuten ?? -Infinity) > (best.heikin_tokuten ?? -Infinity) ? cur : best
      );
    }

    return { a: condA, b: condB, c: condC, bestOtherSenko, bestOtherCandidate };
  }

  function riskCount(r: Risk): number {
    return (r.a ? 1 : 0) + (r.b ? 1 : 0) + (r.c ? 1 : 0);
  }

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
    n3: number;
    threeTanHit: number;
    stakedYen: number;
    payoutYen: number;
    missingOddsOnHit: number;
  };

  function evalStrategy(rows: Analyzed[], secondPicker: (a: Analyzed, risk: Risk) => EntryRow): StrategyResult {
    const res: StrategyResult = { n: rows.length, twoBodyHit: 0, n3: 0, threeTanHit: 0, stakedYen: 0, payoutYen: 0, missingOddsOnHit: 0 };
    for (const a of rows) {
      const risk = computeRisk(a);
      const second = secondPicker(a, risk);
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

  function altSecondFactory(threshold: number, useNewRanking: boolean) {
    return (a: Analyzed, risk: Risk): EntryRow => {
      const rc = riskCount(risk);
      if (rc >= threshold) {
        const pick = useNewRanking ? risk.bestOtherCandidate : risk.bestOtherSenko;
        if (pick != null) return pick;
      }
      return a.bantesu!;
    };
  }

  function countRiskBucket(rows: Analyzed[], threshold: number): number {
    return rows.filter((a) => riskCount(computeRisk(a)) >= threshold).length;
  }

  function countForcedFallback(rows: Analyzed[], threshold: number, useNewRanking: boolean): number {
    return rows.filter((a) => {
      const risk = computeRisk(a);
      if (riskCount(risk) < threshold) return false;
      return useNewRanking ? risk.bestOtherCandidate == null : risk.bestOtherSenko == null;
    }).length;
  }

  function reportStrategy(label: string, r: StrategyResult) {
    console.log(
      `    ${label}: n=${r.n} / 2着的中率=${pct(r.twoBodyHit, r.n)}(${r.twoBodyHit}/${r.n}) / ` +
        `3連単的中率=${pct(r.threeTanHit, r.n3)}(${r.threeTanHit}/${r.n3}, 評価対象外=${r.n - r.n3}件) / ` +
        `回収率=${roiPct(r.payoutYen, r.stakedYen)}(payout=${r.payoutYen.toFixed(0)}円/staked=${r.stakedYen}円)` +
        `${r.missingOddsOnHit > 0 ? ` ※的中したがoddsテーブル欠落=${r.missingOddsOnHit}件` : ""}`
    );
  }

  function runSplit(label: string, rows: Analyzed[]) {
    console.log(`\n■ ${label}（n=${rows.length}）`);
    reportStrategy("ベース（常に番手を2着）", evalStrategy(rows, baselineSecond));

    for (const threshold of [2, 3]) {
      const riskN = countRiskBucket(rows, threshold);
      console.log(`  [risk>=${threshold}] 該当レース数=${riskN}件${flag(riskN)}`);

      const fallbackOld = countForcedFallback(rows, threshold, false);
      console.log(
        `   (a) script2版（他ライン先頭のみ）差し替え先=heikin_tokuten最大（フォールバック=${fallbackOld}件）`
      );
      reportStrategy("差し替え結果", evalStrategy(rows, altSecondFactory(threshold, false)));

      const fallbackNew = countForcedFallback(rows, threshold, true);
      console.log(
        `   (b) 新ランキング版（候補プール全体）差し替え先=heikin_tokuten最大（フォールバック=${fallbackNew}件）`
      );
      reportStrategy("差し替え結果", evalStrategy(rows, altSecondFactory(threshold, true)));
    }
  }

  runSplit("train", stratTrain);
  runSplit("test", stratTest);

  // ---- 差し替えが実際に発生したサブセットだけでの内訳（新ランキング版のみ、script2の補足に相当） ----
  function runSwitchedSubsetOnly(label: string, rows: Analyzed[], threshold: number, useNewRanking: boolean) {
    const switched = rows.filter((a) => {
      const risk = computeRisk(a);
      if (riskCount(risk) < threshold) return false;
      return useNewRanking ? risk.bestOtherCandidate != null : risk.bestOtherSenko != null;
    });
    console.log(`\n  ▲ ${label} risk>=${threshold} かつ実際に差し替え発生（${useNewRanking ? "新ランキング版" : "script2版"}、n=${switched.length}${flag(switched.length)}）`);
    if (switched.length === 0) {
      console.log("    該当レースなし");
      return;
    }
    reportStrategy("同レース群でベースのままだった場合", evalStrategy(switched, baselineSecond));
    reportStrategy("同レース群で実際に差し替えた場合", evalStrategy(switched, altSecondFactory(threshold, useNewRanking)));
  }

  console.log("\n=== 7. 補足: 差し替えが実際に発生したサブセットだけでの比較（新ランキング版） ===");
  for (const threshold of [2, 3]) {
    runSwitchedSubsetOnly("train", stratTrain, threshold, true);
    runSwitchedSubsetOnly("test", stratTest, threshold, true);
  }

  console.log("\n=== 完了 ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
