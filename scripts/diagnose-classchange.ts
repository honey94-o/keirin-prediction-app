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
import { determineClassChange, classChangeAdjustmentFactor } from "../lib/scoring";

async function main() {
  const db = getDb();

  const rows = await db.execute(`
    SELECT ra.kaisai_date, rc.class_rank, rc.prev_class_rank,
           r.finish_pos
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN racers rc ON rc.snum = e.snum
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE r.finish_pos IS NOT NULL
  `);
  const data = rows.rows as unknown as {
    kaisai_date: string;
    class_rank: string | null;
    prev_class_rank: string | null;
    finish_pos: number;
  }[];

  console.log(`集計対象: ${data.length}出走\n`);

  // 昇級/降級/変動なし別の勝率・連対率（adjustmentFactorを考慮しない全期間）
  const byChange = new Map<string, { entries: number; wins: number; top3: number }>();
  for (const row of data) {
    const change = determineClassChange({
      class_rank: row.class_rank,
      prev_class_rank: row.prev_class_rank,
    });
    const bucket = byChange.get(change) ?? { entries: 0, wins: 0, top3: 0 };
    bucket.entries++;
    if (row.finish_pos === 1) bucket.wins++;
    if (row.finish_pos <= 3) bucket.top3++;
    byChange.set(change, bucket);
  }
  console.log("昇級/降級/変動なし 別の勝率・複勝率（全期間）:");
  for (const [change, b] of byChange) {
    console.log(
      `  ${change}: 出走${b.entries} 勝率${((b.wins / b.entries) * 100).toFixed(1)}% 複勝率${((b.top3 / b.entries) * 100).toFixed(1)}%`
    );
  }

  // adjustmentFactorが効いている期間（切替月・1ヶ月後）だけに絞った場合
  const byChangeAdjusted = new Map<string, { entries: number; wins: number; top3: number }>();
  for (const row of data) {
    const factor = classChangeAdjustmentFactor(row.kaisai_date);
    if (factor === 0) continue; // 調整が効かない期間は対象外
    const change = determineClassChange({
      class_rank: row.class_rank,
      prev_class_rank: row.prev_class_rank,
    });
    const bucket = byChangeAdjusted.get(change) ?? { entries: 0, wins: 0, top3: 0 };
    bucket.entries++;
    if (row.finish_pos === 1) bucket.wins++;
    if (row.finish_pos <= 3) bucket.top3++;
    byChangeAdjusted.set(change, bucket);
  }
  console.log("\n昇級/降級/変動なし 別の勝率・複勝率（調整が効く期間＝1〜2月/7〜8月のみ）:");
  for (const [change, b] of byChangeAdjusted) {
    console.log(
      `  ${change}: 出走${b.entries} 勝率${((b.wins / b.entries) * 100).toFixed(1)}% 複勝率${((b.top3 / b.entries) * 100).toFixed(1)}%`
    );
  }

  console.log(`\n(注: 現在の日付が2026年8月のため「調整が効く期間」はほぼ全レースが該当。`);
  console.log(`級班替えは1月・7月なので、7月以前の記録が無いと昇級/降級の分母が薄い可能性あり)`);
}

main();
