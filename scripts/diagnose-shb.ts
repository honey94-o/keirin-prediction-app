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

type Row = { race_id: number; car_num: number; h: number; b: number; s: number; finish_pos: number | null };

function bucketOf(n: number): string {
  if (n === 0) return "0";
  if (n <= 3) return "1-3";
  if (n <= 7) return "4-7";
  if (n <= 14) return "8-14";
  return "15+";
}

async function main() {
  const db = getDb();

  const res = await db.execute(`
    SELECT e.race_id, e.car_num,
           rc.home_lead_count as h, rc.back_lead_count as b, rc.standing_count as s,
           r.finish_pos as finish_pos
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE rc.home_lead_count IS NOT NULL AND r.finish_pos IS NOT NULL
  `);
  const rows = res.rows as unknown as Row[];
  console.log(`母数: ${rows.length}出走（S/H/B確定・結果確定分）`);

  // 1) 生カウントのバケット別 真の勝率（選手個人の通算値なので、母数バイアス
  //    ＝出走機会が多い選手ほど高カウントになりやすい点に留意）
  function bucketReport(label: string, get: (r: Row) => number) {
    const buckets = new Map<string, { entries: number; wins: number }>();
    for (const row of rows) {
      const key = bucketOf(get(row));
      const b = buckets.get(key) ?? { entries: 0, wins: 0 };
      b.entries++;
      if (row.finish_pos === 1) b.wins++;
      buckets.set(key, b);
    }
    console.log(`\n${label} バケット別 真の勝率:`);
    for (const key of ["0", "1-3", "4-7", "8-14", "15+"]) {
      const b = buckets.get(key);
      if (!b) continue;
      console.log(`  ${key}: 出走${b.entries} 勝利${b.wins} 勝率${((b.wins / b.entries) * 100).toFixed(1)}%`);
    }
  }
  bucketReport("home_lead_count(H)", (r) => r.h);
  bucketReport("back_lead_count(B)", (r) => r.b);
  bucketReport("standing_count(S)", (r) => r.s);

  // 2) レース内での相対順位（そのレースの出走選手の中でH/B/Sが何番目に高いか）
  //    による真の勝率。フィールド構成の違いを打ち消せるためより実戦に近い指標。
  function rankReport(label: string, get: (r: Row) => number) {
    const byRace = new Map<number, Row[]>();
    for (const row of rows) {
      const arr = byRace.get(row.race_id) ?? [];
      arr.push(row);
      byRace.set(row.race_id, arr);
    }
    const rankStats = new Map<number, { entries: number; wins: number }>();
    for (const arr of byRace.values()) {
      const sorted = [...arr].sort((a, b) => get(b) - get(a));
      sorted.forEach((row, idx) => {
        const rank = idx + 1;
        const s = rankStats.get(rank) ?? { entries: 0, wins: 0 };
        s.entries++;
        if (row.finish_pos === 1) s.wins++;
        rankStats.set(rank, s);
      });
    }
    console.log(`\n${label} レース内順位別 真の勝率（1位=そのレースで最もH/B/S値が高い選手）:`);
    for (let rank = 1; rank <= 9; rank++) {
      const s = rankStats.get(rank);
      if (!s) continue;
      console.log(`  ${rank}番目: 出走${s.entries} 勝利${s.wins} 勝率${((s.wins / s.entries) * 100).toFixed(1)}%`);
    }
  }
  rankReport("home_lead_count(H)", (r) => r.h);
  rankReport("back_lead_count(B)", (r) => r.b);
  rankReport("standing_count(S)", (r) => r.s);
}

main();
