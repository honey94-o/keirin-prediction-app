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

/**
 * 【検証結果: 不採用（交絡と判明）】
 * 「違う検証はじめて」の一環。entries.gear_ratio（選手個々のこの日のギヤ倍率）が、
 * その選手自身の過去の平均ギヤ倍率からどれだけ変化しているかを見て、
 * 「いつもよりギヤを上げた/下げた日は着順が変わるか」を検証する。
 *
 * 未来情報混入を避けるため、各出走の「本人の過去平均」はその出走より前の
 * kaisai_dateのレコードだけを使う（ウィンドウ関数のROWS BETWEEN UNBOUNDED
 * PRECEDING AND 1 PRECEDINGで実現）。SQL 1本で計算できるため、predictRaceを
 * 使う他のdiagnose-*.tsよりずっと高速。
 *
 * 結果: pooledでは「変更あり」が「変更なし」よりはっきり成績が悪く
 * （勝率10-12% vs 14.5%、train/testとも同方向で再現）新シグナルに見えたが、
 * ギヤを変更する選手はracers.heikin_tokuten平均77前後・SS/S1級0%と、
 * そもそも「変更なし」群（平均85・SS/S1級9.6%）よりも大幅に弱い選手に
 * 偏っていた（交絡）。heikin_tokuten 70-82の同レベル帯だけで比較し直すと
 * 差はほぼ消失（勝率12.0% vs 10.8%、3着内率はむしろ変更ありが上回る
 * 39.5% vs 38.4%）。既存のheikin_tokuten/class_rankが既に説明している
 * 弱さを、ギヤ変更という別の見た目で再検出していただけと判断し不採用。
 */

type Row = {
  snum: string;
  kaisai_date: string;
  gear_ratio: number;
  hist_avg: number | null;
  hist_count: number;
  finish_pos: number | null;
};

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT snum, kaisai_date, gear_ratio, hist_avg, hist_count, finish_pos
    FROM (
      SELECT e.snum, ra.kaisai_date, e.gear_ratio, r.finish_pos,
        AVG(e.gear_ratio) OVER (
          PARTITION BY e.snum ORDER BY ra.kaisai_date, e.race_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS hist_avg,
        COUNT(*) OVER (
          PARTITION BY e.snum ORDER BY ra.kaisai_date, e.race_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS hist_count
      FROM entries e
      JOIN races ra ON ra.id = e.race_id
      LEFT JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
      WHERE e.gear_ratio IS NOT NULL
    ) t
    WHERE hist_count >= 5
    ORDER BY kaisai_date
  `);
  const rows = result.rows as unknown as Row[];
  console.log(`対象: ${rows.length}件（本人の過去ギヤ倍率記録5件以上）`);

  type Rec = { deviation: number; win: boolean; rentai: boolean; kaisaiDate: string };
  const records: Rec[] = rows
    .filter((r) => r.finish_pos != null && r.hist_avg != null)
    .map((r) => ({
      deviation: r.gear_ratio - (r.hist_avg as number),
      win: r.finish_pos === 1,
      rentai: (r.finish_pos as number) <= 3,
      kaisaiDate: r.kaisai_date,
    }));
  console.log(`着順あり: ${records.length}件\n`);

  const increased = records.filter((r) => r.deviation >= 0.02);
  const decreased = records.filter((r) => r.deviation <= -0.02);
  const unchanged = records.filter((r) => r.deviation > -0.02 && r.deviation < 0.02);

  function stats(data: Rec[]): string {
    if (data.length === 0) return "-";
    const win = (data.filter((r) => r.win).length / data.length) * 100;
    const rentai = (data.filter((r) => r.rentai).length / data.length) * 100;
    return `勝率${win.toFixed(1)}% 3着内率${rentai.toFixed(1)}%(n=${data.length})`;
  }

  console.log("■ 本人の過去平均からのギヤ倍率変化 → 成績");
  console.log(`  上げた（+0.02以上）: ${stats(increased)}`);
  console.log(`  下げた（-0.02以下）: ${stats(decreased)}`);
  console.log(`  変えず（±0.02未満）: ${stats(unchanged)}`);

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("--- train/testホールドアウト（上げた vs 下げた vs 変えず）---");
  for (const [label, data] of [
    ["上げた", increased],
    ["下げた", decreased],
    ["変えず", unchanged],
  ] as const) {
    const train = data.filter((r) => r.kaisaiDate < splitDate);
    const test = data.filter((r) => r.kaisaiDate >= splitDate);
    console.log(`  ${label}: [train] ${stats(train)} / [test] ${stats(test)}`);
  }
}

main();
