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
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

interface EntryRow {
  car_num: number;
  line_group: number | null;
  line_position: string | null;
}
interface ResultRow {
  car_num: number;
  finish_pos: number | null;
}

async function main() {
  const db = getDb();

  const raceIdsResult = await db.execute(`
    SELECT DISTINCT r.race_id FROM results r WHERE r.finish_pos IS NOT NULL ORDER BY r.race_id
  `);
  const raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);

  let total = 0;
  let top2SameLine = 0;
  let top3AllSameLine = 0;

  // 1着の隊列位置別に、2着がどの立場だったか
  const secondGivenFirst = new Map<string, Map<string, number>>();
  // 1着の隊列位置別の出現数
  const firstPositionCounts = new Map<string, number>();

  for (const raceId of raceIds) {
    const entriesResult = await db.execute({
      sql: `SELECT car_num, line_group, line_position FROM entries WHERE race_id = ?`,
      args: [raceId],
    });
    const entries = entriesResult.rows as unknown as EntryRow[];
    if (entries.length === 0) continue;
    const byCarNum = new Map(entries.map((e) => [e.car_num, e]));

    const resultsResult = await db.execute({
      sql: `SELECT car_num, finish_pos FROM results WHERE race_id = ? AND finish_pos IS NOT NULL ORDER BY finish_pos`,
      args: [raceId],
    });
    const results = resultsResult.rows as unknown as ResultRow[];
    const top3 = results.filter((r) => r.finish_pos != null && r.finish_pos <= 3);
    if (top3.length < 3) continue;
    const [first, second, third] = top3;

    const firstEntry = byCarNum.get(first.car_num);
    const secondEntry = byCarNum.get(second.car_num);
    const thirdEntry = byCarNum.get(third.car_num);
    if (!firstEntry?.line_group || !secondEntry?.line_group || !thirdEntry?.line_group) continue;

    total++;

    const sameLine12 = firstEntry.line_group === secondEntry.line_group;
    if (sameLine12) top2SameLine++;

    const sameLine13 = firstEntry.line_group === thirdEntry.line_group;
    if (sameLine12 && sameLine13) top3AllSameLine++;

    // 1着の隊列位置 → 2着が「同ラインの誰か（隊列位置）」か「別ラインの誰か（隊列位置）」かを分類
    const firstPos = firstEntry.line_position ?? "不明";
    firstPositionCounts.set(firstPos, (firstPositionCounts.get(firstPos) ?? 0) + 1);

    const secondLabel = sameLine12
      ? `同ライン-${secondEntry.line_position ?? "不明"}`
      : `別ライン-${secondEntry.line_position ?? "不明"}`;
    const map = secondGivenFirst.get(firstPos) ?? new Map<string, number>();
    map.set(secondLabel, (map.get(secondLabel) ?? 0) + 1);
    secondGivenFirst.set(firstPos, map);
  }

  console.log(`集計対象: ${total}レース（上位3着とも隊列情報が判明したもの）\n`);

  console.log(`1-2着が同ライン: ${top2SameLine}/${total} (${((top2SameLine / total) * 100).toFixed(1)}%)`);
  console.log(`1-2-3着とも同ライン: ${top3AllSameLine}/${total} (${((top3AllSameLine / total) * 100).toFixed(1)}%)`);
  console.log();

  console.log("1着の隊列位置別に見た2着の内訳:");
  for (const [firstPos, count] of firstPositionCounts) {
    console.log(`\n[1着が${firstPos}] ${count}件`);
    const map = secondGivenFirst.get(firstPos)!;
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
    for (const [label, c] of sorted) {
      console.log(`  2着=${label}: ${c}件 (${((c / count) * 100).toFixed(1)}%)`);
    }
  }
}

main();
