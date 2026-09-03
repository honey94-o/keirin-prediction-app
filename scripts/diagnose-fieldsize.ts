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
 * 出走頭数（フィールドサイズ）別の◎的中率・複勝率を診断する。
 * predictRaceを新たに呼ばず、既存のbacktest.ts実行で保存済みのpredictions
 * テーブル（◎行）とresultsを突き合わせるだけの軽量集計（Neonの遅延が
 * 大きい状況でもフルbacktestを回さずに検証できる）。
 *
 * 出走頭数はentriesの実件数（欠場等を含む申込数ではなく実際に走った数）を使う。
 */
async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT ra.id as race_id, ra.syumoku, ra.kaisai_date,
           (SELECT COUNT(*) FROM entries e WHERE e.race_id = ra.id) as field_size,
           p.car_num as honmei_car_num,
           r.finish_pos as honmei_finish_pos
    FROM races ra
    JOIN predictions p ON p.race_id = ra.id AND p.mark = '◎'
    JOIN results r ON r.race_id = ra.id AND r.car_num = p.car_num
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date
  `);
  type Row = {
    race_id: number;
    syumoku: string | null;
    kaisai_date: string;
    field_size: number;
    honmei_car_num: number;
    honmei_finish_pos: number;
  };
  const rows = result.rows as unknown as Row[];
  console.log(`対象レース（predictions保存済み・結果確定）: ${rows.length}件`);

  const byField = new Map<number, { n: number; win: number; top3: number }>();
  for (const r of rows) {
    const s = byField.get(r.field_size) ?? { n: 0, win: 0, top3: 0 };
    s.n++;
    if (r.honmei_finish_pos === 1) s.win++;
    if (r.honmei_finish_pos <= 3) s.top3++;
    byField.set(r.field_size, s);
  }

  console.log("\n■ 出走頭数別 ◎的中率・複勝率:");
  for (const fieldSize of [...byField.keys()].sort((a, b) => a - b)) {
    const s = byField.get(fieldSize)!;
    console.log(
      `  ${fieldSize}人立て: 単勝的中率${((s.win / s.n) * 100).toFixed(1)}% (${s.win}/${s.n}) / ` +
        `複勝率${((s.top3 / s.n) * 100).toFixed(1)}%`
    );
  }

  // ---- 出走頭数×レースステージの重複確認 ----
  const stageByField = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const stage = raceStage(r.syumoku);
    const m = stageByField.get(r.field_size) ?? new Map<string, number>();
    m.set(stage, (m.get(stage) ?? 0) + 1);
    stageByField.set(r.field_size, m);
  }
  console.log("\n■ 出走頭数別 レースステージ内訳（予選に偏っていないか確認）:");
  for (const fieldSize of [...stageByField.keys()].sort((a, b) => a - b)) {
    const m = stageByField.get(fieldSize)!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const parts = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([stage, c]) => `${stage}${((c / total) * 100).toFixed(0)}%`)
      .join(" / ");
    console.log(`  ${fieldSize}人立て(n=${total}): ${parts}`);
  }

  // ---- 予選を除外した上でも出走頭数の効果が残るか ----
  const nonYosenByField = new Map<number, { n: number; win: number }>();
  for (const r of rows) {
    if (raceStage(r.syumoku) === "予選") continue;
    const s = nonYosenByField.get(r.field_size) ?? { n: 0, win: 0 };
    s.n++;
    if (r.honmei_finish_pos === 1) s.win++;
    nonYosenByField.set(r.field_size, s);
  }
  console.log("\n■ 予選を除外した上での出走頭数別 ◎単勝的中率:");
  for (const fieldSize of [...nonYosenByField.keys()].sort((a, b) => a - b)) {
    const s = nonYosenByField.get(fieldSize)!;
    if (s.n < 20) {
      console.log(`  ${fieldSize}人立て: n=${s.n}件のみのため参考外`);
      continue;
    }
    console.log(`  ${fieldSize}人立て: ${((s.win / s.n) * 100).toFixed(1)}% (${s.win}/${s.n})`);
  }

  // ---- ホールドアウト検証：9人立ての予選除く低下が train/test で再現するか ----
  const nonYosenRows = rows.filter((r) => raceStage(r.syumoku) !== "予選");
  const dates = [...new Set(nonYosenRows.map((r) => r.kaisai_date))].sort();
  const splitIdx = Math.floor(dates.length * (2 / 3));
  const splitDate = dates[splitIdx];
  const trainRows = nonYosenRows.filter((r) => r.kaisai_date < splitDate);
  const testRows = nonYosenRows.filter((r) => r.kaisai_date >= splitDate);
  console.log(
    `\n■ ホールドアウト検証（予選除く、train=${dates[0]}〜${dates[splitIdx - 1]}、test=${splitDate}〜${dates[dates.length - 1]}）:`
  );

  function summarize(label: string, data: Row[]) {
    const nine = data.filter((r) => r.field_size === 9);
    const others = data.filter((r) => r.field_size !== 9 && r.field_size >= 5);
    const rate = (arr: Row[]) =>
      arr.length > 0 ? ((arr.filter((r) => r.honmei_finish_pos === 1).length / arr.length) * 100).toFixed(1) : "-";
    console.log(
      `  [${label}] 9人立て: ${rate(nine)}% (n=${nine.length}) / それ以外: ${rate(others)}% (n=${others.length})`
    );
  }
  summarize("train", trainRows);
  summarize("test", testRows);
}

main();
