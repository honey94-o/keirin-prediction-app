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

/**
 * 記録会の能力別評価（S/A/B/C/D）が、新人選手（デビュー済み・debut_classあり）
 * の実際の勝率と相関するかを診断する。相関が弱ければ現状の期別フラットボーナス
 * のままとし、強ければ等級別に加点量を変えることを検討する。
 */
async function main() {
  const db = getDb();

  const res = await db.execute(`
    SELECT e.race_id, e.car_num, rc.kisokukai_grade as grade, rc.debut_class as debut_class,
           r.finish_pos as finish_pos
    FROM entries e
    JOIN racers rc ON rc.snum = e.snum
    LEFT JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE rc.debut_class IS NOT NULL AND rc.kisokukai_grade IS NOT NULL
  `);
  type Row = { race_id: number; car_num: number; grade: string; debut_class: string; finish_pos: number | null };
  const rows = res.rows as unknown as Row[];
  const withResult = rows.filter((r) => r.finish_pos != null);
  console.log(`新人（記録会データあり）の総出走: ${rows.length}件、結果確定: ${withResult.length}件`);

  const byGrade = new Map<string, { starts: number; wins: number; top3: number }>();
  for (const r of withResult) {
    const b = byGrade.get(r.grade) ?? { starts: 0, wins: 0, top3: 0 };
    b.starts++;
    if (r.finish_pos === 1) b.wins++;
    if (r.finish_pos != null && r.finish_pos <= 3) b.top3++;
    byGrade.set(r.grade, b);
  }
  console.log("\n能力別評価別: 出走数・勝利数・勝率・複勝率");
  for (const grade of ["S", "A", "B", "C", "D", "-"]) {
    const b = byGrade.get(grade);
    if (!b) continue;
    console.log(
      `  ${grade}: 出走${b.starts} 勝利${b.wins} 勝率${((b.wins / b.starts) * 100).toFixed(1)}% ` +
        `複勝率${((b.top3 / b.starts) * 100).toFixed(1)}%`
    );
  }

  // 期別の内訳も参考に
  const byClass = new Map<string, { starts: number; wins: number }>();
  for (const r of withResult) {
    const b = byClass.get(r.debut_class) ?? { starts: 0, wins: 0 };
    b.starts++;
    if (r.finish_pos === 1) b.wins++;
    byClass.set(r.debut_class, b);
  }
  console.log("\n期別: 出走数・勝利数・勝率");
  for (const [cls, b] of byClass) {
    console.log(`  ${cls}: 出走${b.starts} 勝利${b.wins} 勝率${((b.wins / b.starts) * 100).toFixed(1)}%`);
  }
}

main();
