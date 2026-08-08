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
import { predictRace } from "../lib/predict";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

// ユーザー質問「厳選（毎日margin上位10件）だと1日の買い目は何通りくらい？
// 過去30日では？」への回答用。過去30日分、各日「本命margin上位10件」を選び、
// その本命フォーメーションの合計点数を集計する（結果・オッズは不要、
// フォーメーションのサイズだけ見ればよいため軽量）。

async function main() {
  const db = getDb();
  const today = todayJstStr();
  const days = Array.from({ length: 30 }, (_, i) => addDaysToDateStr(today, -1 - i));

  const dailyTotals: { date: string; races: number; points: number }[] = [];

  for (const date of days) {
    const raceRows = await db.execute({
      sql: "SELECT id FROM races WHERE kaisai_date = ?",
      args: [date],
    });
    const raceIds = (raceRows.rows as unknown as { id: number }[]).map((r) => r.id);
    if (raceIds.length === 0) {
      dailyTotals.push({ date, races: 0, points: 0 });
      continue;
    }

    const results = await Promise.all(
      raceIds.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scored.length < 2) return null;
        const margin = prediction.scored[0].totalScore - prediction.scored[1].totalScore;
        const honmeiScenario = prediction.scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario) return null;
        return { margin, points: honmeiScenario.formation.combinations.length };
      })
    );
    const valid = results.filter((r): r is NonNullable<typeof r> => r != null);
    const top10 = [...valid].sort((a, b) => b.margin - a.margin).slice(0, 10);
    const totalPoints = top10.reduce((sum, r) => sum + r.points, 0);
    dailyTotals.push({ date, races: top10.length, points: totalPoints });
  }

  console.log("日付 | 選定レース数 | 合計点数 | 金額(100円/点)");
  for (const d of dailyTotals) {
    console.log(`${d.date}: ${d.races}レース ${d.points}点 ${d.points * 100}円`);
  }

  const withData = dailyTotals.filter((d) => d.races > 0);
  const totalPoints = withData.reduce((s, d) => s + d.points, 0);
  const avg = totalPoints / withData.length;
  const min = Math.min(...withData.map((d) => d.points));
  const max = Math.max(...withData.map((d) => d.points));
  console.log(
    `\n過去30日（データあり${withData.length}日）: 平均${avg.toFixed(1)}点/日 ` +
      `最小${min}点 最大${max}点 （平均${(avg * 100).toFixed(0)}円/日）`
  );
}

main();
