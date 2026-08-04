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

  // 車番別の真の勝率（内枠が有利という定説を自前データで確認）
  const carNumRows = await db.execute(`
    SELECT e.car_num, COUNT(*) as entries, SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE r.finish_pos IS NOT NULL
    GROUP BY e.car_num
    ORDER BY e.car_num
  `);
  console.log("車番別の母数・勝利数・真の勝率:");
  for (const row of carNumRows.rows as unknown as { car_num: number; entries: number; wins: number }[]) {
    console.log(`  車番${row.car_num}: 出走${row.entries} 勝利${row.wins} 勝率${((row.wins / row.entries) * 100).toFixed(1)}%`);
  }

  // レース内でのS（standing_count）順位別の真の勝率（再掲、母数を厳密に確認）
  const res = await db.execute(`
    SELECT e.race_id, e.car_num, rc.standing_count as s, r.finish_pos as finish_pos
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE rc.standing_count IS NOT NULL AND r.finish_pos IS NOT NULL
  `);
  type Row = { race_id: number; car_num: number; s: number; finish_pos: number };
  const rows = res.rows as unknown as Row[];
  const byRace = new Map<number, Row[]>();
  for (const row of rows) {
    const arr = byRace.get(row.race_id) ?? [];
    arr.push(row);
    byRace.set(row.race_id, arr);
  }
  // 車番とSを両方見て「Sランク1位かつ内枠(車番<=3)」等の組み合わせが1着だった選手の
  // finish_posの分布（1着に来やすいか）を集計
  const combo = new Map<string, { total: number; wins: number }>();
  for (const arr of byRace.values()) {
    const sorted = [...arr].sort((a, b) => b.s - a.s || a.car_num - b.car_num);
    sorted.forEach((row, idx) => {
      const sRank = idx + 1;
      const key = `Sランク${sRank <= 3 ? "上位(1-3)" : "下位"}×車番${row.car_num <= 3 ? "内(1-3)" : row.car_num <= 6 ? "中(4-6)" : "外(7+)"}`;
      const c = combo.get(key) ?? { total: 0, wins: 0 };
      c.total++;
      if (row.finish_pos === 1) c.wins++;
      combo.set(key, c);
    });
  }
  console.log("\nSランク×車番グループ別の真の勝率:");
  for (const [key, c] of [...combo.entries()].sort((a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total)) {
    console.log(`  ${key}: 出走${c.total} 勝利${c.wins} 勝率${((c.wins / c.total) * 100).toFixed(1)}%`);
  }
}

main();
