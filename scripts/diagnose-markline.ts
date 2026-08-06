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

// 仮説1（ユーザー指摘）：マーク（kimarite_mark_count）が多い選手は、
// 自分のラインが1・2着を占める「ライン1-2」決着時に2着に回りやすい
// （1着は取りに行かず、番手からマークして確実に2着を拾うタイプ）。
// 仮説2（ユーザー指摘）：番手の選手のうち、マークより差し（kimarite_sashi_count）が
// 多いタイプは、番手のまま自分のラインの先頭を差して1着を取ることが多い。
async function diagnoseMarkPredicts2nd() {
  const db = getDb();
  console.log("=== 仮説1: マーク型選手は「ライン1-2」決着で2着になりやすいか ===");

  const rows = await db.execute(`
    SELECT e.race_id, e.line_group, e.line_position, res.finish_pos,
           r.kimarite_nige_count, r.kimarite_makuri_count, r.kimarite_sashi_count, r.kimarite_mark_count
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN results res ON res.race_id = e.race_id AND res.car_num = e.car_num
    WHERE res.finish_pos IS NOT NULL AND e.line_group IS NOT NULL
      AND r.kimarite_nige_count IS NOT NULL AND r.kimarite_makuri_count IS NOT NULL
      AND r.kimarite_sashi_count IS NOT NULL AND r.kimarite_mark_count IS NOT NULL
  `);
  type Row = {
    race_id: number;
    line_group: number;
    line_position: string | null;
    finish_pos: number;
    kimarite_nige_count: number;
    kimarite_makuri_count: number;
    kimarite_sashi_count: number;
    kimarite_mark_count: number;
  };
  const data = rows.rows as unknown as Row[];

  // race_id -> finish_pos=1の行のline_group
  const winnerLineByRace = new Map<number, number>();
  for (const row of data) {
    if (row.finish_pos === 1) winnerLineByRace.set(row.race_id, row.line_group);
  }

  const markRateOf = (row: Row) => {
    const total =
      row.kimarite_nige_count + row.kimarite_makuri_count + row.kimarite_sashi_count + row.kimarite_mark_count;
    return total > 0 ? row.kimarite_mark_count / total : null;
  };

  // 2着の行だけ抽出し、「同じラインが1着も取っている（ライン1-2）」かどうかで分ける
  const secondPlaceRows = data.filter((r) => r.finish_pos === 2);
  const lineWanTsuMarkRates: number[] = [];
  const otherSecondMarkRates: number[] = [];
  for (const row of secondPlaceRows) {
    const rate = markRateOf(row);
    if (rate == null) continue;
    const winnerLine = winnerLineByRace.get(row.race_id);
    if (winnerLine != null && winnerLine === row.line_group) {
      lineWanTsuMarkRates.push(rate);
    } else {
      otherSecondMarkRates.push(rate);
    }
  }
  const avg = (xs: number[]) => (xs.length > 0 ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : null);
  console.log(
    `  ライン1-2の2着(母数${lineWanTsuMarkRates.length}): 平均マーク率${avg(lineWanTsuMarkRates)?.toFixed(1)}%`
  );
  console.log(
    `  それ以外の2着(母数${otherSecondMarkRates.length}): 平均マーク率${avg(otherSecondMarkRates)?.toFixed(1)}%`
  );

  // 比較用：1着の行のマーク率も見る（2着に回るタイプは1着の行では低いはず）
  const firstPlaceRates = data
    .filter((r) => r.finish_pos === 1)
    .map(markRateOf)
    .filter((r): r is number => r != null);
  console.log(`  （参考）全1着(母数${firstPlaceRates.length}): 平均マーク率${avg(firstPlaceRates)?.toFixed(1)}%`);
}

async function diagnoseSashiTypeBeatsSenko() {
  const db = getDb();
  console.log("\n=== 仮説2: 番手でマークより差しが多いタイプは、先頭を差して1着を取りやすいか ===");

  const rows = await db.execute(`
    SELECT e_ban.race_id AS race_id,
           r_ban.kimarite_nige_count, r_ban.kimarite_makuri_count,
           r_ban.kimarite_sashi_count, r_ban.kimarite_mark_count,
           res_ban.finish_pos AS ban_finish, res_sen.finish_pos AS sen_finish
    FROM entries e_ban
    JOIN entries e_sen
      ON e_sen.race_id = e_ban.race_id
     AND e_sen.line_group = e_ban.line_group
     AND e_sen.line_position = '先頭'
    JOIN racers r_ban ON r_ban.snum = e_ban.snum
    JOIN results res_ban ON res_ban.race_id = e_ban.race_id AND res_ban.car_num = e_ban.car_num
    JOIN results res_sen ON res_sen.race_id = e_sen.race_id AND res_sen.car_num = e_sen.car_num
    WHERE e_ban.line_position = '番手'
      AND res_ban.finish_pos IS NOT NULL AND res_sen.finish_pos IS NOT NULL
      AND r_ban.kimarite_nige_count IS NOT NULL AND r_ban.kimarite_makuri_count IS NOT NULL
      AND r_ban.kimarite_sashi_count IS NOT NULL AND r_ban.kimarite_mark_count IS NOT NULL
  `);
  type Row = {
    race_id: number;
    kimarite_nige_count: number;
    kimarite_makuri_count: number;
    kimarite_sashi_count: number;
    kimarite_mark_count: number;
    ban_finish: number;
    sen_finish: number;
  };
  const data = rows.rows as unknown as Row[];

  type Agg = { total: number; banWins: number; banBeatsSenko: number; senWinsBanSecond: number };
  const sashiType: Agg = { total: 0, banWins: 0, banBeatsSenko: 0, senWinsBanSecond: 0 };
  const markType: Agg = { total: 0, banWins: 0, banBeatsSenko: 0, senWinsBanSecond: 0 };

  for (const row of data) {
    const total =
      row.kimarite_nige_count + row.kimarite_makuri_count + row.kimarite_sashi_count + row.kimarite_mark_count;
    if (total === 0) continue; // 決まり手データが無い選手は除外
    const bucket = row.kimarite_sashi_count > row.kimarite_mark_count ? sashiType : markType;
    bucket.total += 1;
    if (row.ban_finish === 1) bucket.banWins += 1;
    if (row.ban_finish < row.sen_finish) bucket.banBeatsSenko += 1;
    if (row.sen_finish === 1 && row.ban_finish === 2) bucket.senWinsBanSecond += 1;
  }

  const report = (label: string, agg: Agg) => {
    const pct = (n: number) => (agg.total > 0 ? ((n / agg.total) * 100).toFixed(1) : "-");
    console.log(
      `  ${label}(母数${agg.total}): 番手が1着${pct(agg.banWins)}% / 番手が先頭より上位${pct(agg.banBeatsSenko)}% / 先頭1着・番手2着${pct(agg.senWinsBanSecond)}%`
    );
  };
  report("差し>マーク型（差し寄り）", sashiType);
  report("マーク>=差し型（マーク寄り）", markType);
}

async function main() {
  await diagnoseMarkPredicts2nd();
  await diagnoseSashiTypeBeatsSenko();
}

main();
