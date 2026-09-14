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
 * 【検証結果: 不採用（A1以上限定なら相関自体は交絡でも閾値依存でもない本物だが、
 * soloCandidateのタイブレーク加点として実装してもbacktest.tsで実利が測定誤差の
 * 範囲（1367件中1件のヒット差）に留まり、既存スコアへの上乗せ効果が確認できな
 * かった）】
 *
 * ユーザー発見の仮説：「競りのライン」＝単騎（line_group人数1）の選手が、
 * 自分より強い"他ライン"の選手の番手を狙って攻撃する展開。単騎選手にとって、
 * 自分より明確に強いライバルが「ライン付き（後ろに番手・3番手を従えている）」場合と
 * 「そのライバルも単騎」の場合とで、勝率に差が出るのではという仮説（ライン付きの
 * 強い先頭は「番手を奪いに行く・差しに行く明確な目標」を単騎選手に与えるが、
 * 同じ強さでも単騎のライバルにはそれがない、という解釈）。
 *
 * 対象: encp LIKE 'wt:%'（line_group・heikin_tokutenの由来が安定しているWINTICKET
 * 由来レースのみ、他のdiagnose-*.tsと同じ制約）。単騎の定義は本番コード
 * （lib/scoring.tsのsoloCandidate）と同じ「line_groupがNULLでない、かつ同レース内で
 * 同じline_groupを持つentriesが自分1人だけ」。レース内の「最強の他選手」は
 * heikin_tokuten最大の選手（自分を除く）。gap = 最強他選手のheikin_tokuten - 自分の
 * heikin_tokuten。gap>=5を主基準とし、「明確に自分より強いライバルがいるレースに絞る
 * （弱い他選手しかいないレースでの比較は無意味）」ことで両グループのライバルの
 * 強さ自体は揃える。rivalHasLine = その最強他選手のline_groupの同レース内人数>=2
 * （NULLは「ラインなし」としてrivalSolo側に含める）。
 *
 * ■ 一次結果（gap>=5、train/testは開催日の時系列2/3分割）
 *   脚質=逃 (n=1121): rivalHasLine 9.2%(train10.3/test7.3, n=736) vs rivalSolo
 *     6.8%(train6.6/test7.5, n=385) … train/testで方向が入れ替わり不安定。理論的にも
 *     逃は「番手に付いて差す」戦法を取らないため妥当（対象外として扱う）。
 *   脚質=両 (n=3472): rivalHasLine 5.3%(train6.0/test3.9, n=1302) vs rivalSolo
 *     1.2%(train1.4/test0.9, n=2170) … train/testとも同方向、gapが大きい。
 *   脚質=追 (n=3975): rivalHasLine 1.9%(train2.0/test1.9, n=2535) vs rivalSolo
 *     0.7%(train0.9/test0.0, n=1440) … train/testとも同方向。
 *
 * ■ 交絡チェック1: 自分自身のheikin_tokuten三分位で層別（脚質=両+追、gap>=5）
 *   三分位境界50.3/79.3。低位帯はrivalHasLine側がn=8しかなく比較不能（この帯の
 *   レースはほぼ全てrivalSolo=2463件で、全体が弱い水準のレースには強いライン付き
 *   ライバル自体がほぼ出現しないという構造的な偏り）。中位帯hasLine2.2%(n=1693)
 *   vs solo1.0%(n=794)、高位帯hasLine3.8%(n=2134)vs solo3.1%(n=355)で方向は維持
 *   するが高位帯は差が縮む。脚質別に見ると追だけ高位帯で逆転（hasLine2.4%(n=1128)
 *   vs solo3.0%(n=201)、両は低/中/高とも方向維持）。全体として「弱い単騎選手が
 *   たまたま強いライン付きライバルに当たりやすい」という単純な選択バイアスでは
 *   ないが、自分自身の強さと無関係な独立効果とも言い切れない。
 *
 * ■ 交絡チェック2: class_rank（CLASS_RANK_SCORES>=55 vs <55、脚質=両+追、gap>=5）
 *   A1以上(n=4584): rivalHasLine 4.9%(train5.5/test3.9, n=1315) vs rivalSolo
 *     0.8%(train0.9/test0.4, n=3269) … train/testとも同方向、差が大きい。
 *   A2以下(n=2863): rivalHasLine 2.1%(train2.3/test1.8, n=2520) vs rivalSolo
 *     3.2%(train3.0/test4.4, n=343) … train/testとも「逆転」、solo側が高い。
 *   → heikin_tokuten三分位と整合する交互作用：この効果は「自分がA1以上（相応の
 *   実力がある）」場合にしか成立せず、A2以下では方向が反転する。単純な交絡では
 *   なく、本物の交互作用と判断した。
 *
 * ■ 交絡チェック3: gap閾値を変えても再現するか
 *   gap>=3: 両 rivalHasLine6.5%(n=1575) vs solo2.0%(n=3158)／追 rivalHasLine2.5%
 *     (n=3058) vs solo1.1%(n=1810)。train/testとも同方向。
 *   gap>=8: 両 rivalHasLine3.2%(n=844) vs solo0.5%(n=916)／追 rivalHasLine1.0%
 *     (n=1573) vs solo0.3%(n=778)。train/testとも同方向。
 *   → gap=5固有のアーティファクトではなく、閾値を動かしても方向は崩れない。
 *
 * ■ 交絡チェック4: 出走頭数（field size）
 *   rivalHasLine群の平均出走頭数7.05 vs rivalSolo群6.95とほぼ同じ（脚質=両+追、
 *   gap>=5）。出走頭数はほぼ7-9頭に集中しており三分位が実質2分割になったが、
 *   少頭数帯・多頭数帯どちらでもhasLine>soloの方向は維持した。頭数の交絡ではない。
 *
 * ■ 総合判断
 *   相関自体は「A1以上の単騎選手」という限定では交絡・閾値依存のいずれでもなく
 *   本物と判断した（A2以下では逆転するため無条件の主効果としては採用不可）。
 *   この限定範囲だけをsoloCandidate選出のタイブレーク加点として実装（脚質=両/追、
 *   class_rank A1以上、gap>=5、加点15点）しbacktest.ts(3000レース、同一レース
 *   集合の前後比較)で検証：
 *     単騎一撃 的中率: 1.7%(23/1367) → 1.8%(24/1367)
 *     単騎一撃 回収率: 93.4%(賭け金282,200円/払戻263,520円)
 *                     → 96.8%(賭け金282,200円/払戻273,250円)　※払戻+9,730円
 *     ◎単勝的中率・◎複勝的中率・本命/逃げ粘り込み/まくり差し一撃/対抗の各シナリオ:
 *       完全に無変化（対象条件（A1以上×両/追×単騎×gap>=5×最強他選手がライン付き）が
 *       狭く、soloCandidateの選出自体が入れ替わったレースが少なかったため）
 *   1367件中たった1件のヒット差は測定誤差の範囲内であり、有意な改善とは言えない。
 *   番手個人勝率・周回数・単騎個人成績・class_rank交互作用(逃×先頭/番手)など、
 *   このプロジェクトで繰り返し確認されてきた「単独では強い相関でも、既存の
 *   加重ブレンド済みスコアに混ぜると上乗せ効果が消える」パターンと一致する。
 *   lib/scoring.tsにはsoloSeriLineBonus関数を残しSERI_LINE_BONUS=0で無効化した
 *   （2026-09-14）。
 */

type EntryRow = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  kaisai_date: string;
  kyakushitsu: string | null;
  heikin_tokuten: number | null;
  class_rank: string | null;
};

type Rec = {
  kyakushitsu: string;
  win: boolean;
  date: string;
  gap: number;
  selfTokuten: number;
  classScore: number;
  rivalHasLine: boolean;
  fieldSize: number;
};

async function main() {
  const db = getDb();

  const entRes = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, ra.kaisai_date,
           r.kyakushitsu, r.heikin_tokuten, r.class_rank
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

  // レースごとにグルーピング
  const byRace = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const arr = byRace.get(e.race_id) ?? [];
    arr.push(e);
    byRace.set(e.race_id, arr);
  }

  function buildRecords(gapThreshold: number): Rec[] {
    const records: Rec[] = [];
    for (const [raceId, members] of byRace) {
      const fieldSize = members.length;
      // line_group人数（NULLは母数に数えない＝単騎判定にNULLは使わない、本番と同じ）
      const lineSizeByGroup = new Map<number, number>();
      for (const m of members) {
        if (m.line_group == null) continue;
        lineSizeByGroup.set(m.line_group, (lineSizeByGroup.get(m.line_group) ?? 0) + 1);
      }
      for (const self of members) {
        if (self.line_group == null) continue;
        if ((lineSizeByGroup.get(self.line_group) ?? 0) !== 1) continue; // 単騎のみ
        if (!self.kyakushitsu || self.heikin_tokuten == null) continue;
        const fp = finishByRaceCar.get(`${raceId}:${self.car_num}`);
        if (fp == null) continue;

        // 自分以外で最強（heikin_tokuten最大）の他選手
        let strongest: EntryRow | null = null;
        for (const other of members) {
          if (other.car_num === self.car_num) continue;
          if (other.heikin_tokuten == null) continue;
          if (!strongest || other.heikin_tokuten > strongest.heikin_tokuten!) strongest = other;
        }
        if (!strongest) continue;
        const gap = strongest.heikin_tokuten! - self.heikin_tokuten;
        if (gap < gapThreshold) continue;

        const rivalLineSize =
          strongest.line_group != null ? (lineSizeByGroup.get(strongest.line_group) ?? 1) : 1;
        const rivalHasLine = rivalLineSize >= 2;

        records.push({
          kyakushitsu: self.kyakushitsu,
          win: fp === 1,
          date: self.kaisai_date,
          gap,
          selfTokuten: self.heikin_tokuten,
          classScore: self.class_rank ? CLASS_RANK_SCORES[self.class_rank] ?? 50 : 50,
          rivalHasLine,
          fieldSize,
        });
      }
    }
    return records;
  }

  function rate(a: Rec[]): string {
    return a.length ? ((100 * a.filter((r) => r.win).length) / a.length).toFixed(1) + "%(n=" + a.length + ")" : "-(n=0)";
  }
  function rateTT(a: Rec[], split: string): string {
    const train = a.filter((r) => r.date < split);
    const test = a.filter((r) => r.date >= split);
    return `全体${rate(a)} train${rate(train)} test${rate(test)}`;
  }

  function splitDate(recs: Rec[]): string {
    const dates = [...new Set(recs.map((r) => r.date))].sort();
    return dates[Math.floor(dates.length * (2 / 3))];
  }

  // ============ 一次結果（gap>=5）============
  console.log("\n========== 一次結果: gap>=5 ==========");
  const records5 = buildRecords(5);
  const allSplit = splitDate(records5);
  for (const k of ["逃", "両", "追"]) {
    const sub = records5.filter((r) => r.kyakushitsu === k);
    const hasLine = sub.filter((r) => r.rivalHasLine);
    const solo = sub.filter((r) => !r.rivalHasLine);
    console.log(`脚質=${k} (n=${sub.length})`);
    console.log(`  rivalHasLine: ${rateTT(hasLine, allSplit)}`);
    console.log(`  rivalSolo   : ${rateTT(solo, allSplit)}`);
  }

  // ============ 交絡チェック1: 自分のheikin_tokuten三分位（両+追のみ） ============
  console.log("\n========== 交絡チェック1: 自分のheikin_tokuten三分位（脚質=両+追、gap>=5）==========");
  const ryoOi5 = records5.filter((r) => r.kyakushitsu === "両" || r.kyakushitsu === "追");
  const tokutenSorted = [...ryoOi5].map((r) => r.selfTokuten).sort((a, b) => a - b);
  const t1 = tokutenSorted[Math.floor(tokutenSorted.length / 3)];
  const t2 = tokutenSorted[Math.floor((tokutenSorted.length * 2) / 3)];
  console.log(`三分位境界: ${t1.toFixed(1)} / ${t2.toFixed(1)}`);
  const tiers: [string, (r: Rec) => boolean][] = [
    ["低位帯", (r) => r.selfTokuten < t1],
    ["中位帯", (r) => r.selfTokuten >= t1 && r.selfTokuten < t2],
    ["高位帯", (r) => r.selfTokuten >= t2],
  ];
  for (const [label, pred] of tiers) {
    const sub = ryoOi5.filter(pred);
    const hasLine = sub.filter((r) => r.rivalHasLine);
    const solo = sub.filter((r) => !r.rivalHasLine);
    console.log(`${label} (n=${sub.length}, 自heikin_tokuten範囲考慮)`);
    console.log(`  rivalHasLine: ${rateTT(hasLine, allSplit)}`);
    console.log(`  rivalSolo   : ${rateTT(solo, allSplit)}`);
  }
  // 脚質別（両単独・追単独）でも三分位を見る（両+追混合が単なる脚質構成比の
  // 交絡になっていないか）
  for (const k of ["両", "追"]) {
    console.log(`--- 脚質=${k}のみでの三分位 ---`);
    const subK = records5.filter((r) => r.kyakushitsu === k);
    const sortedK = [...subK].map((r) => r.selfTokuten).sort((a, b) => a - b);
    const kt1 = sortedK[Math.floor(sortedK.length / 3)];
    const kt2 = sortedK[Math.floor((sortedK.length * 2) / 3)];
    const tiersK: [string, (r: Rec) => boolean][] = [
      ["低位帯", (r) => r.selfTokuten < kt1],
      ["中位帯", (r) => r.selfTokuten >= kt1 && r.selfTokuten < kt2],
      ["高位帯", (r) => r.selfTokuten >= kt2],
    ];
    for (const [label, pred] of tiersK) {
      const sub = subK.filter(pred);
      const hasLine = sub.filter((r) => r.rivalHasLine);
      const solo = sub.filter((r) => !r.rivalHasLine);
      console.log(`  ${label} (n=${sub.length}): rivalHasLine ${rate(hasLine)} vs rivalSolo ${rate(solo)}`);
    }
  }

  // ============ 交絡チェック2: class_rank（両+追、gap>=5） ============
  console.log("\n========== 交絡チェック2: class_rank（CLASS_RANK_SCORES>=55 vs <55、脚質=両+追、gap>=5）==========");
  const classGroups: [string, (r: Rec) => boolean][] = [
    ["A1以上(>=55)", (r) => r.classScore >= 55],
    ["A2以下(<55)", (r) => r.classScore < 55],
  ];
  for (const [label, pred] of classGroups) {
    const sub = ryoOi5.filter(pred);
    const hasLine = sub.filter((r) => r.rivalHasLine);
    const solo = sub.filter((r) => !r.rivalHasLine);
    console.log(`${label} (n=${sub.length})`);
    console.log(`  rivalHasLine: ${rateTT(hasLine, allSplit)}`);
    console.log(`  rivalSolo   : ${rateTT(solo, allSplit)}`);
  }

  // ============ 交絡チェック3: 別のgap閾値 ============
  for (const gapThreshold of [3, 8]) {
    console.log(`\n========== 交絡チェック3: gap>=${gapThreshold} ==========`);
    const recs = buildRecords(gapThreshold);
    const split = splitDate(recs);
    for (const k of ["逃", "両", "追"]) {
      const sub = recs.filter((r) => r.kyakushitsu === k);
      const hasLine = sub.filter((r) => r.rivalHasLine);
      const solo = sub.filter((r) => !r.rivalHasLine);
      console.log(`脚質=${k} (n=${sub.length})`);
      console.log(`  rivalHasLine: ${rateTT(hasLine, split)}`);
      console.log(`  rivalSolo   : ${rateTT(solo, split)}`);
    }
  }

  // ============ 交絡チェック4: 出走頭数（field size）三分位、両+追、gap>=5 ============
  console.log("\n========== 交絡チェック4: 出走頭数（field size）三分位（脚質=両+追、gap>=5）==========");
  // まずrivalHasLine群とrivalSolo群でfield sizeの分布自体が違うかを見る
  const fsHasLine = ryoOi5.filter((r) => r.rivalHasLine).map((r) => r.fieldSize);
  const fsSolo = ryoOi5.filter((r) => !r.rivalHasLine).map((r) => r.fieldSize);
  const avg = (a: number[]) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : "-");
  console.log(`rivalHasLine群の平均出走頭数: ${avg(fsHasLine)} (n=${fsHasLine.length})`);
  console.log(`rivalSolo群の平均出走頭数   : ${avg(fsSolo)} (n=${fsSolo.length})`);

  const fsSorted = [...ryoOi5].map((r) => r.fieldSize).sort((a, b) => a - b);
  const f1 = fsSorted[Math.floor(fsSorted.length / 3)];
  const f2 = fsSorted[Math.floor((fsSorted.length * 2) / 3)];
  console.log(`出走頭数三分位境界: ${f1} / ${f2}`);
  const fsTiers: [string, (r: Rec) => boolean][] = [
    [`少(<${f1})`, (r) => r.fieldSize < f1],
    [`中(${f1}-${f2})`, (r) => r.fieldSize >= f1 && r.fieldSize < f2],
    [`多(>=${f2})`, (r) => r.fieldSize >= f2],
  ];
  for (const [label, pred] of fsTiers) {
    const sub = ryoOi5.filter(pred);
    const hasLine = sub.filter((r) => r.rivalHasLine);
    const solo = sub.filter((r) => !r.rivalHasLine);
    console.log(`${label} (n=${sub.length})`);
    console.log(`  rivalHasLine: ${rateTT(hasLine, allSplit)}`);
    console.log(`  rivalSolo   : ${rateTT(solo, allSplit)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
