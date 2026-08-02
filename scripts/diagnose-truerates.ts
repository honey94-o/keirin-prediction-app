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

async function main() {
  const db = getDb();

  // 隊列位置ごとの母数（全出走）と実際の1着数（真の勝率）
  const rows = await db.execute(`
    SELECT e.line_position, COUNT(*) as entries, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE e.line_position IS NOT NULL AND r.finish_pos IS NOT NULL
    GROUP BY e.line_position
  `);
  console.log("隊列内位置別の母数・勝利数・真の勝率:");
  for (const row of rows.rows as unknown as { line_position: string; entries: number; wins: number }[]) {
    console.log(`  ${row.line_position}: 出走${row.entries} 勝利${row.wins} 勝率${((row.wins / row.entries) * 100).toFixed(1)}%`);
  }

  // ライン人数別（単騎 vs 複数）の母数・勝率
  const lineSizeRows = await db.execute(`
    SELECT ls.line_size, COUNT(*) as entries, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
    FROM (
      SELECT e.race_id, e.car_num, e.line_group,
             COUNT(*) OVER (PARTITION BY e.race_id, e.line_group) as line_size
      FROM entries e
      WHERE e.line_group IS NOT NULL
    ) ls
    JOIN results r ON r.race_id = ls.race_id AND r.car_num = ls.car_num
    WHERE r.finish_pos IS NOT NULL
    GROUP BY ls.line_size
    ORDER BY ls.line_size
  `);
  console.log("\nライン人数別の母数・勝利数・真の勝率:");
  for (const row of lineSizeRows.rows as unknown as { line_size: number; entries: number; wins: number }[]) {
    console.log(`  ${row.line_size}人ライン: 出走${row.entries} 勝利${row.wins} 勝率${((row.wins / row.entries) * 100).toFixed(1)}%`);
  }

  // 脚質別の母数・勝率
  const kyakuRows = await db.execute(`
    SELECT rc.kyakushitsu, COUNT(*) as entries, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE rc.kyakushitsu IS NOT NULL AND r.finish_pos IS NOT NULL
    GROUP BY rc.kyakushitsu
  `);
  console.log("\n脚質別の母数・勝利数・真の勝率:");
  for (const row of kyakuRows.rows as unknown as { kyakushitsu: string; entries: number; wins: number }[]) {
    console.log(`  ${row.kyakushitsu}: 出走${row.entries} 勝利${row.wins} 勝率${((row.wins / row.entries) * 100).toFixed(1)}%`);
  }
}

main();
