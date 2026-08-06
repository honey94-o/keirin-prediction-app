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

// 仮説：番手の選手のうち、脚質が「逃」の選手は差しで脚を溜めるより
// 前に出て捲りを打ちやすいのではないか（ユーザー指摘）。
// 隊列位置（先頭/番手/3番手）×脚質の組み合わせ別に、①勝率 ②勝ったときの
// 決まり手内訳（捲/差/逃/マ）を集計して検証する。
// 結果はlib/scoring.tsのcalculateKyakushitsuScore（fitScoreテーブル）に反映済み。

type Agg = { total: number; wins: number; kimariteCounts: Map<string, number> };

async function aggregateByLinePosition(linePosition: string) {
  const db = getDb();
  const rows = await db.execute({
    sql: `SELECT r.kyakushitsu, res.finish_pos, res.kimarite
          FROM entries e
          JOIN racers r ON r.snum = e.snum
          JOIN results res ON res.race_id = e.race_id AND res.car_num = e.car_num
          WHERE e.line_position = ? AND res.finish_pos IS NOT NULL`,
    args: [linePosition],
  });
  const data = rows.rows as unknown as {
    kyakushitsu: string | null;
    finish_pos: number;
    kimarite: string | null;
  }[];

  const byKyakushitsu = new Map<string, Agg>();
  for (const row of data) {
    const key = row.kyakushitsu ?? "不明";
    const agg = byKyakushitsu.get(key) ?? { total: 0, wins: 0, kimariteCounts: new Map() };
    agg.total += 1;
    if (row.finish_pos === 1) {
      agg.wins += 1;
      if (row.kimarite) {
        agg.kimariteCounts.set(row.kimarite, (agg.kimariteCounts.get(row.kimarite) ?? 0) + 1);
      }
    }
    byKyakushitsu.set(key, agg);
  }

  console.log(`=== 隊列位置=${linePosition} の選手を脚質別に集計（勝率・決まり手内訳） ===`);
  for (const [kyakushitsu, agg] of [...byKyakushitsu.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const winRate = ((agg.wins / agg.total) * 100).toFixed(1);
    const kimariteTotal = [...agg.kimariteCounts.values()].reduce((a, b) => a + b, 0);
    const pct = (k: string) =>
      kimariteTotal > 0 ? (((agg.kimariteCounts.get(k) ?? 0) / kimariteTotal) * 100).toFixed(1) : "-";
    console.log(
      `  ${linePosition}×脚質${kyakushitsu}: 母数${agg.total} 勝利${agg.wins} 勝率${winRate}% ` +
        `｜勝った時の決まり手(母数${kimariteTotal}): 捲${pct("捲")}% 差${pct("差")}% 逃${pct("逃")}% マ${pct("マ")}%`
    );
  }
  console.log();
}

async function main() {
  for (const pos of ["先頭", "番手", "3番手"]) {
    await aggregateByLinePosition(pos);
  }
}

main();
