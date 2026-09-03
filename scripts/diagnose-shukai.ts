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
import { raceStage } from "../lib/scoring";

/**
 * レースの周回数（races.shukai、4周〜6周）は一度もスコアリングで使われて
 * いない。同じバンク周長でも周回数が違う＝距離が違うレースが混在しており
 * （例: 400mバンクで4周1625m・5周2025mなど）、周回数が多い＝距離が長い
 * ほど後方から差す時間的余裕が生まれ、差し・まくりが決まりやすいのでは
 * という仮説を検証する。レースステージ（決勝は周回数が多い傾向等）との
 * 交絡を避けるため、ステージ別にも見る。
 */
async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT ra.shukai, ra.syumoku, ra.kaisai_date, r.kimarite
    FROM races ra
    JOIN results r ON r.race_id = ra.id
    WHERE r.finish_pos = 1 AND r.kimarite IS NOT NULL
    ORDER BY ra.kaisai_date
  `);
  type Row = { shukai: number; syumoku: string | null; kaisai_date: string; kimarite: string };
  const rows = result.rows as unknown as Row[];
  console.log(`1着決まり手データ: ${rows.length}件\n`);

  function summarize(label: string, data: Row[]) {
    const total = data.length;
    if (total < 30) {
      console.log(`  ${label}: n=${total}件のみのため参考外`);
      return;
    }
    const counts = new Map<string, number>();
    for (const r of data) counts.set(r.kimarite, (counts.get(r.kimarite) ?? 0) + 1);
    const parts = ["逃", "捲", "差"]
      .map((k) => `${k}${(((counts.get(k) ?? 0) / total) * 100).toFixed(1)}%`)
      .join(" / ");
    console.log(`  ${label}(n=${total}): ${parts}`);
  }

  console.log("■ 周回数別 1着決まり手分布（全体）:");
  const byShukai = new Map<number, Row[]>();
  for (const r of rows) {
    const arr = byShukai.get(r.shukai) ?? [];
    arr.push(r);
    byShukai.set(r.shukai, arr);
  }
  for (const shukai of [...byShukai.keys()].sort((a, b) => a - b)) {
    summarize(`${shukai}周`, byShukai.get(shukai)!);
  }

  console.log("\n■ 周回数別 レースステージ内訳（決勝など特定ステージに偏っていないか）:");
  const stageByShukai = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const stage = raceStage(r.syumoku);
    const m = stageByShukai.get(r.shukai) ?? new Map<string, number>();
    m.set(stage, (m.get(stage) ?? 0) + 1);
    stageByShukai.set(r.shukai, m);
  }
  for (const shukai of [...stageByShukai.keys()].sort((a, b) => a - b)) {
    const m = stageByShukai.get(shukai)!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const parts = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([stage, c]) => `${stage}${((c / total) * 100).toFixed(0)}%`)
      .join(" / ");
    console.log(`  ${shukai}周(n=${total}): ${parts}`);
  }

  console.log("\n■ 一般ステージ（予選等の偏り除く）だけに絞った周回数別 決まり手分布:");
  const generalRows = rows.filter((r) => {
    const s = raceStage(r.syumoku);
    return s === "一般" || s === "選抜・特選";
  });
  const byShukaiGeneral = new Map<number, Row[]>();
  for (const r of generalRows) {
    const arr = byShukaiGeneral.get(r.shukai) ?? [];
    arr.push(r);
    byShukaiGeneral.set(r.shukai, arr);
  }
  for (const shukai of [...byShukaiGeneral.keys()].sort((a, b) => a - b)) {
    summarize(`${shukai}周`, byShukaiGeneral.get(shukai)!);
  }

  // ---- ホールドアウト検証：4周 vs 6周の捲り率差がtrain/testで再現するか ----
  console.log("\n■ ホールドアウト検証（一般ステージのみ、4周 vs 6周の捲り率）:");
  const dates = [...new Set(generalRows.map((r) => r.kaisai_date))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainRows = generalRows.filter((r) => r.kaisai_date < splitDate);
  const testRows = generalRows.filter((r) => r.kaisai_date >= splitDate);
  console.log(`  train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}`);

  function makuriRate(data: Row[], shukai: number): string {
    const filtered = data.filter((r) => r.shukai === shukai);
    if (filtered.length < 30) return `n=${filtered.length}件のみ`;
    const makuri = filtered.filter((r) => r.kimarite === "捲").length;
    return `${((makuri / filtered.length) * 100).toFixed(1)}% (n=${filtered.length})`;
  }
  console.log(`  [train] 4周: ${makuriRate(trainRows, 4)} / 6周: ${makuriRate(trainRows, 6)}`);
  console.log(`  [test]  4周: ${makuriRate(testRows, 4)} / 6周: ${makuriRate(testRows, 6)}`);
}

main();
