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

// 「番手のちぎられ率」を検証する。ちぎられ（先頭の車輪から離れて脚を使い果たす/
// 千切られる）を示す直接のデータ（車間距離・映像解析等）はDBに無いため、
// 「先頭は上位（3着以内）でゴールしたのに、番手は大きく崩れた（5着以下）」を
// 操作的定義として代理指標にする（先頭が崩れて共倒れになったケースは除外し、
// 純粋に「番手だけついていけなかった」ケースに絞るため）。
//
// 番手の結果を3分類する：
//   ワンツー：番手が2着（理想形）
//   接戦：番手が3〜4着（僅差で負けた＝ちぎられたとは言えない）
//   ちぎられ：番手が5着以下（先頭は残ったのに番手だけ大きく崩れた）
const CHIGIRARE_THRESHOLD = 5; // この着順以下を「ちぎられ」とみなす

async function main() {
  const db = getDb();

  const rows = await db.execute(`
    SELECT e_sen.race_id, r_ban.kyakushitsu AS ban_kyakushitsu,
           res_sen.finish_pos AS sen_finish, res_ban.finish_pos AS ban_finish
    FROM entries e_sen
    JOIN entries e_ban
      ON e_ban.race_id = e_sen.race_id
     AND e_ban.line_group = e_sen.line_group
     AND e_ban.line_position = '番手'
    JOIN racers r_ban ON r_ban.snum = e_ban.snum
    JOIN results res_sen ON res_sen.race_id = e_sen.race_id AND res_sen.car_num = e_sen.car_num
    JOIN results res_ban ON res_ban.race_id = e_ban.race_id AND res_ban.car_num = e_ban.car_num
    WHERE e_sen.line_position = '先頭'
      AND res_sen.finish_pos IS NOT NULL AND res_ban.finish_pos IS NOT NULL
  `);
  type Row = { race_id: number; ban_kyakushitsu: string | null; sen_finish: number; ban_finish: number };
  const data = rows.rows as unknown as Row[];

  // 先頭が3着以内（＝先頭側は仕事をした）に絞る
  const senTop3 = data.filter((r) => r.sen_finish <= 3);
  console.log(`=== 先頭が3着以内だった時の、番手の結果内訳（母数${senTop3.length}） ===`);

  type Agg = { total: number; wanTsu: number; sessen: number; chigirare: number };
  const overall: Agg = { total: 0, wanTsu: 0, sessen: 0, chigirare: 0 };
  const byKyakushitsu = new Map<string, Agg>();

  for (const row of senTop3) {
    const key = row.ban_kyakushitsu ?? "不明";
    const agg = byKyakushitsu.get(key) ?? { total: 0, wanTsu: 0, sessen: 0, chigirare: 0 };
    agg.total += 1;
    overall.total += 1;
    if (row.ban_finish === 2) {
      agg.wanTsu += 1;
      overall.wanTsu += 1;
    } else if (row.ban_finish >= CHIGIRARE_THRESHOLD) {
      agg.chigirare += 1;
      overall.chigirare += 1;
    } else {
      agg.sessen += 1;
      overall.sessen += 1;
    }
    byKyakushitsu.set(key, agg);
  }

  const report = (label: string, agg: Agg) => {
    const pct = (n: number) => ((n / agg.total) * 100).toFixed(1);
    console.log(
      `  ${label}(母数${agg.total}): ワンツー${pct(agg.wanTsu)}% 接戦(3-4着)${pct(agg.sessen)}% ` +
        `ちぎられ(${CHIGIRARE_THRESHOLD}着以下)${pct(agg.chigirare)}%`
    );
  };
  report("全体", overall);
  console.log();
  for (const [k, agg] of [...byKyakushitsu.entries()].sort((a, b) => b[1].total - a[1].total)) {
    report(`脚質${k}`, agg);
  }

  // 比較用：先頭がちぎられる側に回るケースは稀か（先頭3着以内という前提を外して確認）
  console.log(`\n=== 参考：先頭側の着順分布（全母数${data.length}、先頭が崩れるケースの頻度） ===`);
  const senFinishBuckets = new Map<string, number>();
  for (const row of data) {
    const bucket = row.sen_finish <= 3 ? "1-3着" : row.sen_finish <= 6 ? "4-6着" : "7着以下";
    senFinishBuckets.set(bucket, (senFinishBuckets.get(bucket) ?? 0) + 1);
  }
  for (const [bucket, c] of senFinishBuckets) {
    console.log(`  先頭${bucket}: ${c}件 (${((c / data.length) * 100).toFixed(1)}%)`);
  }
}

main();
