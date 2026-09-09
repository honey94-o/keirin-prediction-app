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

import { getDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, enableReadCache } from "../lib/repository";

/**
 * 【検証結果: 不採用（交絡と判明）】
 * 「違う検証はじめて」を受けての新データ源（entries.pre_race_comment、
 * 選手本人の直前コメント）を使った検証。diagnose-shb-overtake.tsで validated
 * 済みのstanding_count（好スタート回数=履歴の平均的な傾向）とは違い、
 * こちらは「その日その選手が自分でどう言っているか」という日次の意図表明。
 *
 * 仮説: 番手/3番手選手が「自力」「自在」「決めず」等、ラインに縛られない
 * 意図を当日コメントで表明している場合、実際に自分のライン先頭より前で
 * ゴールする（＝ラインを離れて動く）率が、○○君。のように明確にマーク
 * 相手を名指ししている場合より高いのではないか。
 *
 * 結果: line_positionを区別せずに集計すると named=48.3% vs other=35.7%と
 * 大差が出たが、これは交絡だった。3番手は「地域＋３番手」等の集団呼びかけ
 * （other）が大半、番手は「○○君。」の個人名指し（named）が大半という
 * 構造的な偏りがあり、named/otherの差は実質line_position自体の差（番手が
 * 3番手よりゴール率が高いのは当然）を測っていただけ。line_position内で
 * 層別すると差はほぼ消える：
 *   番手: named 49.4% vs other 49.2%（train 49.2%/49.2%、test 50.0%/48.9%）
 *   3番手: named 31.5% vs other 29.7%（train 29.4%/29.0%、test 36.1%/31.0%＝
 *          train/testで差の大きさが安定せずノイズと判断）
 * また「自力」等の直接的な独立宣言（solo）は番手/3番手の母集団ではほぼ
 * 皆無（n=1〜3）で、そもそも検証不能だった。scoring.tsへの反映は見送り。
 */

const SOLO_COMMENT_RE =
  /自力|自在|単騎|自分で|一人で|決めず|流れ見て|取れた位置から|何でも|構えず/;
// 「○○君。」「○○選手。」のように直前コメントで別の選手を名指ししている
// パターン。地域＋「３番手」等の既存ライン情報の言い換えは対象外にしたいが、
// 単純にそれらのパターンを除外し「君/選手」を含むものをNAMEDとする。
const NAMED_COMMENT_RE = /君[。.、]|選手[。.、]|兄[。.、]/;

type Rec = {
  category: "solo" | "named" | "other";
  linePosition: "番手" | "3番手";
  overtookOwnSenko: boolean;
  kaisaiDate: string;
};

function classify(comment: string | null): "solo" | "named" | "other" {
  if (!comment) return "other";
  if (SOLO_COMMENT_RE.test(comment)) return "solo";
  if (NAMED_COMMENT_RE.test(comment)) return "named";
  return "other";
}

async function main() {
  enableReadCache();
  const db = getDb();
  // pre_race_commentのバックフィルは開催日の古い順に進んでいるため、直近レース
  // ではなく「コメントが1件でも入っているレース」だけに絞る（無駄な
  // predictRace呼び出しを避けるため、resultsとの結合より先にここで絞る）。
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM entries e WHERE e.race_id = r.race_id AND e.pre_race_comment IS NOT NULL
       )
     ORDER BY r.race_id`
  );
  let raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit) raceIds = raceIds.slice(0, limit);
  console.log(`対象レース（コメント収集済み）: ${raceIds.length}件${limit ? `（先頭${limit}件に絞り込み）` : ""}`);

  const records: Rec[] = [];
  let commentCoverage = 0;
  let commentTotal = 0;
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scored.length < 3) return [];
        const { scored, race } = prediction;

        const raceResults = await getResultsForRace(raceId);
        const finishByCarNum = new Map(raceResults.map((r) => [r.car_num, r.finish_pos]));

        const recs: Rec[] = [];
        for (const s of scored) {
          if (s.entry.line_position !== "番手" && s.entry.line_position !== "3番手") continue;
          commentTotal++;
          if (s.entry.pre_race_comment) commentCoverage++;

          const senko = scored.find(
            (x) => x.entry.line_group === s.entry.line_group && x.entry.line_position === "先頭"
          );
          if (!senko) continue;
          const myFinish = finishByCarNum.get(s.entry.car_num);
          const senkoFinish = finishByCarNum.get(senko.entry.car_num);
          if (myFinish == null || senkoFinish == null) continue;

          recs.push({
            category: classify(s.entry.pre_race_comment),
            linePosition: s.entry.line_position as "番手" | "3番手",
            overtookOwnSenko: myFinish < senkoFinish,
            kaisaiDate: race.kaisai_date,
          });
        }
        return recs;
      })
    );
    for (const recs of results) records.push(...recs);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(
    `\n番手/3番手の総数: ${commentTotal}件、うちコメント取得済み: ${commentCoverage}件` +
      `（${((commentCoverage / commentTotal) * 100).toFixed(1)}%）\n`
  );

  function rate(data: Rec[]): string {
    return data.length > 0
      ? `${((data.filter((r) => r.overtookOwnSenko).length / data.length) * 100).toFixed(1)}%(n=${data.length})`
      : "-";
  }

  // 重要な交絡: line_position別にcategoryの分布が大きく偏っている
  // （番手は「○○君。」個人名指しが大半、3番手は「地域＋３番手」等の
  // 集団呼びかけが大半）。pooledで比較すると「named vs other」が実質
  // 「番手 vs 3番手」の言い換えになってしまうため、必ずline_position内で
  // 層別して比較する。
  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`train=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}\n`);

  for (const pos of ["番手", "3番手"] as const) {
    const inPos = records.filter((r) => r.linePosition === pos);
    const named = inPos.filter((r) => r.category === "named");
    const other = inPos.filter((r) => r.category === "other");
    const solo = inPos.filter((r) => r.category === "solo");
    console.log(`■ line_position=${pos}（n=${inPos.length}） → 自分のライン先頭を上回ってゴールした率`);
    console.log(`  named（個人名指し）: ${rate(named)}`);
    console.log(`  other（地域・集団呼びかけ等）: ${rate(other)}`);
    console.log(`  solo（自力等、参考: ${rate(solo)}）`);
    const namedTrain = named.filter((r) => r.kaisaiDate < splitDate);
    const namedTest = named.filter((r) => r.kaisaiDate >= splitDate);
    const otherTrain = other.filter((r) => r.kaisaiDate < splitDate);
    const otherTest = other.filter((r) => r.kaisaiDate >= splitDate);
    console.log(`  [train] named=${rate(namedTrain)} / other=${rate(otherTrain)}`);
    console.log(`  [test]  named=${rate(namedTest)} / other=${rate(otherTest)}\n`);
  }
}

main();
