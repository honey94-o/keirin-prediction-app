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

type Row = {
  race_id: number;
  car_num: number;
  s: number | null;
  finish_pos: number;
  syumoku: string | null;
};

function carNumBucket(carNum: number): "内" | "中" | "外" {
  if (carNum <= 3) return "内";
  if (carNum <= 6) return "中";
  return "外";
}

async function main() {
  const db = getDb();

  const res = await db.execute(`
    SELECT e.race_id, e.car_num, rc.standing_count as s, r.finish_pos as finish_pos, ra.syumoku as syumoku
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN races ra ON ra.id = e.race_id
    WHERE rc.standing_count IS NOT NULL AND r.finish_pos IS NOT NULL
  `);
  const rows = res.rows as unknown as Row[];
  const isMidnight = (s: string | null) => (s ?? "").includes("ミッドナイト");

  const byRace = new Map<number, Row[]>();
  for (const row of rows) {
    const arr = byRace.get(row.race_id) ?? [];
    arr.push(row);
    byRace.set(row.race_id, arr);
  }

  function report(label: string, filter: (arr: Row[]) => boolean) {
    const combo = new Map<string, { total: number; wins: number }>();
    for (const arr of byRace.values()) {
      if (!filter(arr)) continue;
      const sorted = [...arr].sort((a, b) => (b.s ?? 0) - (a.s ?? 0) || a.car_num - b.car_num);
      sorted.forEach((row, idx) => {
        const sRank = idx + 1;
        const key = `${carNumBucket(row.car_num)}_${sRank <= 3 ? "上位" : "下位"}`;
        const c = combo.get(key) ?? { total: 0, wins: 0 };
        c.total++;
        if (row.finish_pos === 1) c.wins++;
        combo.set(key, c);
      });
    }
    console.log(`\n${label}: 車番グループ×Sランク別 真の勝率`);
    for (const [key, c] of [...combo.entries()].sort((a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total)) {
      console.log(`  ${key}: 出走${c.total} 勝利${c.wins} 勝率${((c.wins / c.total) * 100).toFixed(1)}%`);
    }
  }

  report("通常レース（ミッドナイト以外）", (arr) => !isMidnight(arr[0].syumoku));
  report("ミッドナイトレースのみ", (arr) => isMidnight(arr[0].syumoku));
}

main();
