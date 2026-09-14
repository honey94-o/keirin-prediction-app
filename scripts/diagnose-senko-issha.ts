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

import { getDb } from "../lib/db";
import { CLASS_RANK_SCORES } from "../lib/scoring";

/**
 * 【検証結果: 不採用（相関自体は本物だが、既存スコアリングに混ぜても実益なし）】
 *
 * ケイリン格言「先行1車は黙って買え」の検証。先行1車＝レース内でline_group人数
 * 2以上（実在する複数人ライン）のグループがちょうど1つだけで、他の全選手が
 * 単騎（line_group人数1）という状況。ライバルラインとの主導権争いが無いため、
 * そのライン先頭選手は自分のペースを守りやすく、先頭本来の弱点（競り合いによる
 * 消耗）が発生しない、という理屈。WINTICKETのlinePrediction.lineTypeは二分戦/
 * 三分戦/四分戦/細切れの4値までしか確認できず「先行1車」に対応する値は無かった
 * ため、新規スクレイプはせずentries.line_groupから構造的に判定する
 * （既存データのみ、encp='wt:%'に限定）。
 *
 * ■ Step1: feasibility（encp='wt:%'、12,078レース）
 *   先行1車（複数人ラインが1つだけ）　: 277レース（2.3%）
 *   競合あり（複数人ラインが2つ以上）　: 10,583レース（87.6%）
 *   ライン無し（全員単騎）　　　　　　  : 1,218レース（10.1%）
 *   → 母数は薄いが（全体の2.3%）、これは元々「先行1車」自体が珍しい展開である
 *   ことの反映であり、格言が対象とするレースが希少であること自体は想定通り。
 *
 * ■ Step2: 中心仮説（先行1車の先頭勝率 vs 競合ありの先頭勝率、時系列2/3分割）
 *   先行1車の先頭勝率　　: 43.8%(train44.3%/test42.5%, n=272)
 *   競合ありの先頭勝率　　: 20.6%(train20.7%/test20.4%, n=27,411)
 *   → 2倍以上の差があり、train/testとも安定して同方向。格言の主張と整合する
 *   非常に強い相関。
 *
 * ■ Step3a: heikin_tokuten三分位で層別（境界84.0/95.1、両群合算で算出）
 *   低位帯: 先行1車45.5%(train47.0/test42.9, n=178) vs 競合あり18.0%(train17.2/
 *     test19.4, n=9,048)
 *   中位帯: 先行1車49.2%(train45.1/test64.3, n=65)  vs 競合あり23.3%(train24.3/
 *     test21.4, n=9,148)
 *   高位帯: 先行1車20.7%(train26.3/test10.0, n=29)  vs 競合あり20.5%(train20.5/
 *     test20.4, n=9,215)
 *   → 低位・中位帯（先行1車の89%を占める）では効果が明確かつtrain/testとも
 *   同方向で安定。最高位帯だけn=29と薄く、train26.3%→test10.0%と方向が
 *   不安定で効果を確認できなかった（「強い選手がたまたま先行1車になりやすい」
 *   という単純な選択バイアスでは説明できない＝低中位帯でこそ効果が大きいため、
 *   むしろ逆の交絡関係）。母数が薄すぎるため、この帯特有の除外ロジックは
 *   実装に入れていない。
 *
 * ■ Step3a-2: class_rankで層別
 *   A1以上(>=55): 先行1車35.0%(train33.3/test39.1, n=80)  vs 競合あり20.0%
 *     (train20.3/test19.3, n=16,147)
 *   A2以下(<55) : 先行1車47.4%(train49.2/test43.8, n=192) vs 競合あり21.5%
 *     (train21.3/test21.9, n=11,264)
 *   級班別詳細（母数薄いSS/S1除き単調）:
 *     S2(70点): 先行1車26.9%(n=26) vs 競合あり17.9%(n=6,631)
 *     A1(55点): 先行1車41.7%(n=48) vs 競合あり21.9%(n=6,679)
 *     A2(40点): 先行1車37.7%(n=69) vs 競合あり20.1%(n=6,278)
 *     A3(25点): 先行1車52.8%(n=123) vs 競合あり22.8%(n=4,935)
 *   → class_rankで統制してもtrain/testとも先行1車側が一貫して上回り、
 *   class_rankの言い換えではないと確認した。
 *
 * ■ Step3b: 脚質で層別（先行1車の先頭選手自身の脚質）
 *   脚質=逃: 先行1車45.9%(n=194) vs 競合あり22.7%(n=19,511)
 *   脚質=両: 先行1車43.1%(n=58)  vs 競合あり16.2%(n=6,968)
 *   脚質=追: 先行1車25.0%(n=20、母数薄い) vs 競合あり10.0%(n=932)
 *   → どの脚質でも先行1車側が上回り、逆転は無かった（追は母数が薄く参考程度）。
 *
 * ■ Step3c: 記事の注意点の検証（先頭選手自身の決まり手＝逃げ優位か捲り優位か）
 *   先行1車のうち kimarite_nige_count > kimarite_makuri_count（逃優位）:
 *     47.2%(train48.4/test44.4, n=176)
 *   逆に kimarite_makuri_count > kimarite_nige_count（捲り優位）:
 *     38.2%(train40.6/test34.8, n=55)
 *   脚質=逃に絞っても同じ方向で再現（むしろ差が拡大）:
 *     逃優位49.3%(train52.0/test42.9, n=144) vs 捲り優位32.3%(train36.8/
 *     test25.0, n=31)
 *   → 記事の注意点（捲り優位の選手は一人旅のペース管理に不慣れで先行1車の
 *   恩恵が薄い）はtrain/testとも同方向で支持された。ただし捲り優位でも
 *   競合ありの基準値(20〜23%)は上回っているため、ボーナスをゼロにはせず
 *   半減させるに留めた。
 *
 * ■ Step5: backtest.ts --limit=3000（同一レース集合での前後比較、SENKO_ISSHA_BONUS=15・
 *   捲り優位は半減の7.5でlib/scoring.tsのcalculateKyakushitsuScoreに試験導入）
 *   ◎単勝的中率　　: 42.0%(1259/2999) → 41.9%(1256/2999)　（-0.1pt、誤差範囲）
 *   ◎複勝的中率　　: 76.2%(2285)      → 76.2%(2286)　　　　（ほぼ無変化）
 *   本命　　　　　　: 的中23.2%(695/2999)→23.2%(696/2999)・回収111.4%→111.8%
 *   逃げ粘り込み　　: 的中6.6%(183/2762)→6.5%(180/2762)・回収83.2%→84.2%
 *   まくり/差し一撃　: 的中7.3%(200/2741)→7.4%(204/2744)・回収102.8%→103.0%
 *   対抗　　　　　　: 的中12.7%(30/237)→12.7%(30/237)・回収72.4%→72.4%（無変化）
 *   単騎一撃　　　　: 的中1.7%(23/1367)→1.6%(22/1366)・回収93.5%→89.9%
 *   全シナリオ合成　: 的中33.2%(997/2999)→33.3%(1000/2999)・回収99.4%→99.6%
 *   3連複ボックス的中率: 38.7%(1162/2999) → 38.7%(1162/2999)（無変化）
 *
 * ■ 総合判断
 *   単体の相関（先行1車の先頭選手勝率43.8% vs 競合あり20.6%、2倍以上の差）は
 *   heikin_tokuten三分位・class_rank・脚質のいずれで層別してもtrain/testとも
 *   同方向で再現し、交絡でも閾値依存でもない本物の効果と判断した。記事の注意点
 *   （捲り優位だと効果が薄い）もtrain/testで再現し支持された。
 *   しかし「先行1車」自体が全体のわずか2.3%（272/12,078レース）しか無く、
 *   3000レースの検証セットでも対象は高々70件前後に限られる。既存スコアは
 *   classRankScore・winRateScore・placeRateScore経由で先頭選手本人の強さを
 *   既に別ルートで織り込んでおり、fitScore/baseScoreへの加点で
 *   totalScoreの軸選定（本命・逃げ粘り込み・単騎一撃の各候補選定）が実際に
 *   入れ替わったレースはごく僅かだった。本命・逃げ粘り込み・まくり/差し一撃は
 *   わずかに改善方向、単騎一撃はわずかに悪化方向と結果の方向が割れ、全シナリオ
 *   合成も+0.2ptと誤差範囲に留まった。番手個人勝率・class_rank交互作用
 *   (逃×先頭/番手)・競りのライン（scripts/diagnose-solo-seri-line.ts）等、この
 *   プロジェクトで繰り返し確認されてきた「単独では強い相関でも、既存の加重
 *   ブレンド済みスコアに混ぜると上乗せ効果が消える」パターンと一致すると判断し、
 *   lib/scoring.tsにはSENKO_ISSHA_BONUS=0で無効化して残した（2026-09-15）。
 *
 * ■ 実装（無効化して残置）
 *   lib/scoring.tsのcalculateKyakushitsuScoreにSENKO_ISSHA_BONUS（先頭選手が
 *   「レース内で複数人ラインが自分のラインだけ」の時に加点、本人の決まり手が
 *   捲り優位なら半減）を追加したが、上記の理由によりSENKO_ISSHA_BONUS=0に
 *   戻して不採用とした。fitScoreは既に100点頭打ち（逃×先頭で95点）のため、
 *   そちらに混ぜると効果が消える。classChangeAdjustmentと同じくbaseScore確定後
 *   の加点として実装し、頭打ちを回避する構造自体は妥当だったが、対象レースの
 *   希少さゆえにbacktestで実益が確認できなかった。
 */

type EntryRow = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  kaisai_date: string;
  kyakushitsu: string | null;
  heikin_tokuten: number | null;
  class_rank: string | null;
  kimarite_nige_count: number | null;
  kimarite_makuri_count: number | null;
};

type SenkoRec = {
  win: boolean;
  date: string;
  heikinTokuten: number | null;
  classScore: number;
  kyakushitsu: string | null;
  nigeCount: number | null;
  makuriCount: number | null;
};

type ContestedRec = {
  win: boolean;
  date: string;
  heikinTokuten: number | null;
  classScore: number;
  kyakushitsu: string | null;
};

function rate(arr: { win: boolean }[]): string {
  return arr.length
    ? ((100 * arr.filter((r) => r.win).length) / arr.length).toFixed(1) + "%(n=" + arr.length + ")"
    : "-(n=0)";
}

function rateTT(arr: { win: boolean; date: string }[], split: string): string {
  const train = arr.filter((r) => r.date < split);
  const test = arr.filter((r) => r.date >= split);
  return `全体${rate(arr)} train${rate(train)} test${rate(test)}`;
}

async function main() {
  const db = getDb();

  const entRes = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, e.line_position, ra.kaisai_date,
           r.kyakushitsu, r.heikin_tokuten, r.class_rank,
           r.kimarite_nige_count, r.kimarite_makuri_count
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%'
  `);
  const entries = entRes.rows as unknown as EntryRow[];
  console.log(`対象出走行数（wt:レース全体）: ${entries.length}`);

  const raceIds = [...new Set(entries.map((e) => e.race_id))];
  const finishByRaceCar = new Map<string, number>();
  const CHUNK = 2000;
  for (let i = 0; i < raceIds.length; i += CHUNK) {
    const chunk = raceIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT race_id, car_num, finish_pos FROM results WHERE race_id IN (${placeholders}) AND finish_pos IS NOT NULL`,
      args: chunk,
    });
    for (const row of r.rows as unknown as { race_id: number; car_num: number; finish_pos: number }[]) {
      finishByRaceCar.set(`${row.race_id}:${row.car_num}`, row.finish_pos);
    }
  }

  const byRace = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const arr = byRace.get(e.race_id) ?? [];
    arr.push(e);
    byRace.set(e.race_id, arr);
  }

  let totalRaces = 0;
  let senkoIsshaRaces = 0;
  let contestedRaces = 0;
  let otherRaces = 0;

  const senkoRecs: SenkoRec[] = [];
  const contestedRecs: ContestedRec[] = [];

  for (const [raceId, members] of byRace) {
    totalRaces++;
    const lineSizeByGroup = new Map<number, number>();
    for (const m of members) {
      if (m.line_group == null) continue;
      lineSizeByGroup.set(m.line_group, (lineSizeByGroup.get(m.line_group) ?? 0) + 1);
    }
    const multiGroups = [...lineSizeByGroup.entries()].filter(([, size]) => size >= 2);

    if (multiGroups.length === 1) {
      senkoIsshaRaces++;
      const [groupId] = multiGroups[0];
      const leader = members.find((m) => m.line_group === groupId && m.line_position === "先頭");
      if (leader) {
        const fp = finishByRaceCar.get(`${raceId}:${leader.car_num}`);
        if (fp != null) {
          senkoRecs.push({
            win: fp === 1,
            date: leader.kaisai_date,
            heikinTokuten: leader.heikin_tokuten,
            classScore: leader.class_rank ? CLASS_RANK_SCORES[leader.class_rank] ?? 50 : 50,
            kyakushitsu: leader.kyakushitsu,
            nigeCount: leader.kimarite_nige_count,
            makuriCount: leader.kimarite_makuri_count,
          });
        }
      }
    } else if (multiGroups.length >= 2) {
      contestedRaces++;
      for (const [groupId] of multiGroups) {
        const leader = members.find((m) => m.line_group === groupId && m.line_position === "先頭");
        if (!leader) continue;
        const fp = finishByRaceCar.get(`${raceId}:${leader.car_num}`);
        if (fp == null) continue;
        contestedRecs.push({
          win: fp === 1,
          date: leader.kaisai_date,
          heikinTokuten: leader.heikin_tokuten,
          classScore: leader.class_rank ? CLASS_RANK_SCORES[leader.class_rank] ?? 50 : 50,
          kyakushitsu: leader.kyakushitsu,
        });
      }
    } else {
      otherRaces++;
    }
  }

  console.log("\n========== Step1: feasibility ==========");
  console.log(`全レース数: ${totalRaces}`);
  console.log(
    `先行1車（複数人ラインが1つだけ）: ${senkoIsshaRaces} (${((100 * senkoIsshaRaces) / totalRaces).toFixed(1)}%)`
  );
  console.log(
    `競合あり（複数人ラインが2つ以上）: ${contestedRaces} (${((100 * contestedRaces) / totalRaces).toFixed(1)}%)`
  );
  console.log(`ライン無し（全員単騎）: ${otherRaces} (${((100 * otherRaces) / totalRaces).toFixed(1)}%)`);
  console.log(`先行1車で先頭選手のfinishが取れたレコード数: ${senkoRecs.length}`);
  console.log(`競合ありで各ライン先頭選手のfinishが取れたレコード数: ${contestedRecs.length}`);

  const allDatesSenko = [...new Set(senkoRecs.map((r) => r.date))].sort();
  const allDatesContested = [...new Set(contestedRecs.map((r) => r.date))].sort();
  const splitSenko = allDatesSenko[Math.floor(allDatesSenko.length * (2 / 3))];
  const splitContested = allDatesContested[Math.floor(allDatesContested.length * (2 / 3))];

  console.log("\n========== Step2: 先頭選手勝率比較（中心仮説） ==========");
  console.log(`先行1車の先頭勝率: ${rateTT(senkoRecs, splitSenko)}`);
  console.log(`競合ありの先頭勝率: ${rateTT(contestedRecs, splitContested)}`);

  console.log("\n========== Step3a: heikin_tokuten三分位で層別 ==========");
  const allTokuten = [...senkoRecs, ...contestedRecs]
    .map((r) => r.heikinTokuten)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const t1 = allTokuten[Math.floor(allTokuten.length / 3)];
  const t2 = allTokuten[Math.floor((allTokuten.length * 2) / 3)];
  console.log(`三分位境界: ${t1.toFixed(1)} / ${t2.toFixed(1)}`);
  const tiers: [string, (t: number | null) => boolean][] = [
    ["低位帯", (t) => t != null && t < t1],
    ["中位帯", (t) => t != null && t >= t1 && t < t2],
    ["高位帯", (t) => t != null && t >= t2],
  ];
  for (const [label, pred] of tiers) {
    const s = senkoRecs.filter((r) => pred(r.heikinTokuten));
    const c = contestedRecs.filter((r) => pred(r.heikinTokuten));
    console.log(`${label}: 先行1車[${rateTT(s, splitSenko)}] vs 競合あり[${rateTT(c, splitContested)}]`);
  }

  console.log("\n========== Step3a-2: class_rankで層別 ==========");
  const classGroups: [string, (c: number) => boolean][] = [
    ["A1以上(>=55)", (c) => c >= 55],
    ["A2以下(<55)", (c) => c < 55],
  ];
  for (const [label, pred] of classGroups) {
    const s = senkoRecs.filter((r) => pred(r.classScore));
    const c = contestedRecs.filter((r) => pred(r.classScore));
    console.log(`${label}: 先行1車[${rateTT(s, splitSenko)}] vs 競合あり[${rateTT(c, splitContested)}]`);
  }
  const classRankByScore: Record<number, string> = {
    100: "SS",
    85: "S1",
    70: "S2",
    55: "A1",
    40: "A2",
    25: "A3",
  };
  console.log("--- 級班別詳細 ---");
  for (const score of [100, 85, 70, 55, 40, 25]) {
    const s = senkoRecs.filter((r) => r.classScore === score);
    const c = contestedRecs.filter((r) => r.classScore === score);
    console.log(`${classRankByScore[score]}(${score}点): 先行1車${rate(s)} vs 競合あり${rate(c)}`);
  }

  console.log("\n========== Step3b: 脚質で層別（先行1車の先頭選手自身の脚質） ==========");
  for (const k of ["逃", "両", "追"]) {
    const s = senkoRecs.filter((r) => r.kyakushitsu === k);
    const c = contestedRecs.filter((r) => r.kyakushitsu === k);
    console.log(`脚質=${k}: 先行1車${rate(s)} vs 競合あり${rate(c)}`);
  }

  console.log("\n========== Step3c: 記事の注意点（逃優位 vs 捲り優位） ==========");
  const withCounts = senkoRecs.filter((r) => r.nigeCount != null && r.makuriCount != null);
  console.log(`決まり手カウントあり: n=${withCounts.length} / 全先行1車 n=${senkoRecs.length}`);
  const nigeDominant = withCounts.filter((r) => (r.nigeCount ?? 0) > (r.makuriCount ?? 0));
  const makuriDominant = withCounts.filter((r) => (r.makuriCount ?? 0) > (r.nigeCount ?? 0));
  console.log(`逃優位(nige>makuri): ${rateTT(nigeDominant, splitSenko)}`);
  console.log(`捲り優位(makuri>nige): ${rateTT(makuriDominant, splitSenko)}`);

  console.log("--- 脚質=逃の先頭選手のみで同じ比較 ---");
  const nigeKyakushitsu = withCounts.filter((r) => r.kyakushitsu === "逃");
  const ndNige = nigeKyakushitsu.filter((r) => (r.nigeCount ?? 0) > (r.makuriCount ?? 0));
  const mdNige = nigeKyakushitsu.filter((r) => (r.makuriCount ?? 0) > (r.nigeCount ?? 0));
  console.log(`脚質=逃 かつ 逃優位: ${rateTT(ndNige, splitSenko)}`);
  console.log(`脚質=逃 かつ 捲り優位: ${rateTT(mdNige, splitSenko)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
