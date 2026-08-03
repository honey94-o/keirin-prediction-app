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

  console.log("=== bank_info テーブルの現状 ===");
  const bankInfoRows = await db.execute(
    "SELECT jocd, keirinjo_name, nige_pct, makuri_pct, sashi_pct, updated_at FROM bank_info ORDER BY jocd"
  );
  console.log(`登録済み: ${bankInfoRows.rows.length}件`);
  for (const row of bankInfoRows.rows as unknown as Record<string, unknown>[]) {
    console.log(" ", row);
  }

  console.log("\n=== 開催場別の決まり手（実績、母数10件以上） ===");
  const kimariteByVenue = await db.execute(`
    SELECT ra.jocd, ra.keirinjo_name, r.kimarite, COUNT(*) as c
    FROM results r
    JOIN races ra ON ra.id = r.race_id
    WHERE r.finish_pos = 1 AND r.kimarite IS NOT NULL
    GROUP BY ra.jocd, ra.keirinjo_name, r.kimarite
  `);
  const byVenue = new Map<string, { name: string; total: number; counts: Map<string, number> }>();
  for (const row of kimariteByVenue.rows as unknown as { jocd: string; keirinjo_name: string; kimarite: string; c: number }[]) {
    const entry = byVenue.get(row.jocd) ?? { name: row.keirinjo_name, total: 0, counts: new Map() };
    entry.total += row.c;
    entry.counts.set(row.kimarite, (entry.counts.get(row.kimarite) ?? 0) + row.c);
    byVenue.set(row.jocd, entry);
  }
  const sorted = [...byVenue.entries()].filter(([, v]) => v.total >= 10).sort((a, b) => b[1].total - a[1].total);
  for (const [jocd, v] of sorted) {
    const pct = (k: string) => (((v.counts.get(k) ?? 0) / v.total) * 100).toFixed(1);
    console.log(`  ${v.name}(${jocd}): 母数${v.total} 逃${pct("逃")}% 捲${pct("捲")}% 差${pct("差")}% マ${pct("マ")}%`);
  }

  console.log("\n=== グレード別（grade_kbn）の隊列位置勝率 ===");
  const gradeRows = await db.execute(`
    SELECT ra.grade_kbn, e.line_position, COUNT(*) as entries,
           SUM(CASE WHEN r.finish_pos = 1 THEN 1 ELSE 0 END) as wins
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE e.line_position IS NOT NULL AND r.finish_pos IS NOT NULL
    GROUP BY ra.grade_kbn, e.line_position
    ORDER BY ra.grade_kbn, e.line_position
  `);
  for (const row of gradeRows.rows as unknown as { grade_kbn: string; line_position: string; entries: number; wins: number }[]) {
    console.log(`  ${row.grade_kbn ?? "不明"} / ${row.line_position}: 出走${row.entries} 勝利${row.wins} 勝率${((row.wins / row.entries) * 100).toFixed(1)}%`);
  }

  console.log("\n=== グレード別のレース数 ===");
  const gradeCount = await db.execute(`
    SELECT grade_kbn, COUNT(*) as c FROM races GROUP BY grade_kbn ORDER BY c DESC
  `);
  for (const row of gradeCount.rows as unknown as { grade_kbn: string; c: number }[]) {
    console.log(`  ${row.grade_kbn ?? "不明"}: ${row.c}件`);
  }
}

main();
