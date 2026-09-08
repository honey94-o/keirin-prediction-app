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
import type { ScoredEntry } from "../lib/types";

/**
 * ユーザー指摘「データに基づいた展開予想？」を受けて、lib/scoring.tsの
 * generateRaceDevelopmentForecastが実際に新しい情報を持っているか検証する。
 *
 * 最大の懸念：leadLine（スコア＋脚質の先行加点でランキングした「主導権を
 * 握りそうなライン」）は、本命（総合1位）が自分のラインの先頭である限り、
 * ほぼ確実に「本命のライン」と一致してしまい、既存の本命予想の言い換えに
 * すぎない可能性がある。
 *
 * 検証：
 * 1. leadLineが本命自身のラインと一致する割合（高いほど「言い換え」の疑いが強い）。
 * 2. leadLineと本命のラインが一致する場合/しない場合で、実際の1着がleadLineに
 *    含まれる率を比較する（一致しない場合＝新しい情報を出している場合に、
 *    その情報が実際に当たっているかを見る）。
 * 3. ベースライン（本命のライン＝1着だった率）と比較して、leadLineが
 *    優れているか、単なる言い換えで終わっているかを判定する。
 */

const LINE_POSITION_ORDER: Record<string, number> = { 先頭: 0, 番手: 1, "3番手": 2 };
const AGGRESSION_BONUS: Record<string, number> = { 逃: 5, 両: 0, 追: -5 };

function computeLeadLine(scored: ScoredEntry[]): ScoredEntry[] | null {
  const lineGroups = new Map<number, ScoredEntry[]>();
  for (const s of scored) {
    if (s.entry.line_group == null) continue;
    const arr = lineGroups.get(s.entry.line_group) ?? [];
    arr.push(s);
    lineGroups.set(s.entry.line_group, arr);
  }
  const lines = [...lineGroups.values()]
    .filter((m) => m.length >= 2)
    .map((m) =>
      [...m].sort(
        (a, b) =>
          (LINE_POSITION_ORDER[a.entry.line_position ?? ""] ?? 9) -
          (LINE_POSITION_ORDER[b.entry.line_position ?? ""] ?? 9)
      )
    );
  if (lines.length === 0) return null;
  return [...lines].sort((a, b) => {
    const scoreA = a[0].totalScore + (AGGRESSION_BONUS[a[0].entry.kyakushitsu ?? ""] ?? 0);
    const scoreB = b[0].totalScore + (AGGRESSION_BONUS[b[0].entry.kyakushitsu ?? ""] ?? 0);
    return scoreB - scoreA;
  })[0];
}

type Rec = {
  leadMatchesHonmeiLine: boolean;
  winnerInLeadLine: boolean;
  winnerInHonmeiLine: boolean;
  kaisaiDate: string;
};

async function main() {
  enableReadCache();
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  let raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit) raceIds = raceIds.slice(-limit);
  console.log(`対象レース: ${raceIds.length}件${limit ? `（直近${limit}件に絞り込み）` : ""}`);

  const records: Rec[] = [];
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scored.length < 3) return null;
        const { scored, race } = prediction;
        const honmei = scored[0];
        if (honmei.entry.line_group == null) return null; // 本命が単騎なら対象外

        const leadLine = computeLeadLine(scored);
        if (!leadLine) return null;

        const raceResults = await getResultsForRace(raceId);
        const winnerCarNum = raceResults.find((r) => r.finish_pos === 1)?.car_num;
        if (winnerCarNum == null) return null;

        const leadLineCarNums = new Set(leadLine.map((s) => s.entry.car_num));
        const leadMatchesHonmeiLine = leadLine.some((s) => s.entry.snum === honmei.entry.snum);

        const honmeiLineCarNums = new Set(
          scored.filter((s) => s.entry.line_group === honmei.entry.line_group).map((s) => s.entry.car_num)
        );

        const rec: Rec = {
          leadMatchesHonmeiLine,
          winnerInLeadLine: leadLineCarNums.has(winnerCarNum),
          winnerInHonmeiLine: honmeiLineCarNums.has(winnerCarNum),
          kaisaiDate: race.kaisai_date,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n判定対象（本命がラインに所属するレース）: ${records.length}件\n`);

  const matchCount = records.filter((r) => r.leadMatchesHonmeiLine).length;
  console.log(`■ leadLineが本命自身のラインと一致する割合: ${((matchCount / records.length) * 100).toFixed(1)}% (${matchCount}/${records.length})`);
  console.log("  （高いほど「本命予想の言い換え」の疑いが強い）\n");

  const rate = (data: Rec[], key: "winnerInLeadLine" | "winnerInHonmeiLine") =>
    data.length > 0 ? `${((data.filter((r) => r[key]).length / data.length) * 100).toFixed(1)}%(n=${data.length})` : "-";

  console.log("■ 全体でのベースライン比較");
  console.log(`  1着が本命のラインに含まれる率: ${rate(records, "winnerInHonmeiLine")}`);
  console.log(`  1着がleadLineに含まれる率: ${rate(records, "winnerInLeadLine")}`);

  const diverged = records.filter((r) => !r.leadMatchesHonmeiLine);
  console.log(`\n■ leadLineが本命のラインと異なる場合（新しい情報を出している${diverged.length}件）`);
  console.log(`  1着が本命のライン（旧予想）に含まれる率: ${rate(diverged, "winnerInHonmeiLine")}`);
  console.log(`  1着がleadLine（新予想）に含まれる率: ${rate(diverged, "winnerInLeadLine")}`);

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  const divergedTrain = diverged.filter((r) => r.kaisaiDate < splitDate);
  const divergedTest = diverged.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("--- train/testホールドアウト（乖離時、leadLine vs 本命ラインの1着含有率） ---");
  console.log(`  [train] 本命ライン${rate(divergedTrain, "winnerInHonmeiLine")} / leadLine${rate(divergedTrain, "winnerInLeadLine")}`);
  console.log(`  [test]  本命ライン${rate(divergedTest, "winnerInHonmeiLine")} / leadLine${rate(divergedTest, "winnerInLeadLine")}`);
}

main();
