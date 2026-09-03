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
 * ◎（本命）と対抗（2位）が同じライングループか別ラインかで、◎の的中率・
 * marginの意味合いが変わるのではという仮説を検証する。
 * 同じラインだと「1-2番手が拮抗」なだけでレース全体は一本線が強いかもしれず、
 * 別ラインだと「2つの有力ラインが競っている」ことになり、性質が異なりうる。
 * predictRaceを新たに呼ばず、既存のpredictions（backtest.ts実行で保存済み）+
 * entriesの line_group を突き合わせるだけの軽量集計。
 */
async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT ra.id as race_id,
           p1.car_num as honmei_car, p1.total_score as honmei_score,
           p2.car_num as taikou_car, p2.total_score as taikou_score,
           e1.line_group as honmei_line, e2.line_group as taikou_line,
           r.finish_pos as honmei_finish_pos
    FROM races ra
    JOIN predictions p1 ON p1.race_id = ra.id AND p1.mark = '◎'
    JOIN predictions p2 ON p2.race_id = ra.id AND p2.mark = '○'
    JOIN entries e1 ON e1.race_id = ra.id AND e1.car_num = p1.car_num
    JOIN entries e2 ON e2.race_id = ra.id AND e2.car_num = p2.car_num
    JOIN results r ON r.race_id = ra.id AND r.car_num = p1.car_num
    WHERE r.finish_pos IS NOT NULL
  `);
  type Row = {
    race_id: number;
    honmei_car: number;
    honmei_score: number;
    taikou_car: number;
    taikou_score: number;
    honmei_line: number | null;
    taikou_line: number | null;
    honmei_finish_pos: number;
  };
  const rows = result.rows as unknown as Row[];
  console.log(`対象レース: ${rows.length}件`);

  const groups = {
    sameLine: [] as Row[],
    diffLine: [] as Row[],
  };
  for (const r of rows) {
    if (r.honmei_line == null || r.taikou_line == null) continue;
    if (r.honmei_line === r.taikou_line) groups.sameLine.push(r);
    else groups.diffLine.push(r);
  }

  function summarize(label: string, data: Row[]) {
    const win = data.filter((r) => r.honmei_finish_pos === 1).length;
    const top3 = data.filter((r) => r.honmei_finish_pos <= 3).length;
    const avgMargin = data.reduce((a, r) => a + (r.honmei_score - r.taikou_score), 0) / data.length;
    console.log(
      `  ${label}(n=${data.length}): 単勝的中率${((win / data.length) * 100).toFixed(1)}% / ` +
        `複勝率${((top3 / data.length) * 100).toFixed(1)}% / 平均margin${avgMargin.toFixed(2)}`
    );
  }
  console.log("\n■ ◎-対抗が同じライン vs 別ライン:");
  summarize("同じライン", groups.sameLine);
  summarize("別ライン", groups.diffLine);

  // marginを揃えた上でも差があるか（margin帯別に同ライン/別ラインを比較）
  console.log("\n■ margin帯別に同じライン/別ラインを比較（marginの効果を揃えた上での比較）:");
  const bands: [number, number, string][] = [
    [0, 5, "0-5"],
    [5, 10, "5-10"],
    [10, 20, "10-20"],
    [20, Infinity, "20+"],
  ];
  for (const [lo, hi, label] of bands) {
    const inBand = (r: Row) => {
      const m = r.honmei_score - r.taikou_score;
      return m >= lo && m < hi;
    };
    const same = groups.sameLine.filter(inBand);
    const diff = groups.diffLine.filter(inBand);
    const rate = (arr: Row[]) =>
      arr.length > 0 ? ((arr.filter((r) => r.honmei_finish_pos === 1).length / arr.length) * 100).toFixed(1) : "-";
    console.log(`  margin${label}: 同じライン${rate(same)}%(n=${same.length}) / 別ライン${rate(diff)}%(n=${diff.length})`);
  }
}

main();
