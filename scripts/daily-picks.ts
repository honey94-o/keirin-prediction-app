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

import { predictRace } from "../lib/predict";
import { getRacesByDate, saveDailyPicks } from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * 結果未確定（これから走る）レースの◎-対抗スコア差を計算し、daily_picksに保存する。
 * ホーム画面「本日の厳選レース」の元データ。当日・翌日（ホーム画面の2タブ分）を対象にする。
 * daily-sync.yml実行のたびに呼ぶため、日中にオッズ・並び予想が更新されればその都度
 * 最新の予想に更新される。
 */
async function processDate(kaisaiDate: string): Promise<void> {
  const races = await getRacesByDate(kaisaiDate);
  console.log(`${kaisaiDate}: 対象レース${races.length}件`);
  if (races.length === 0) return;

  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));

  const picks = races
    .map((race, i) => {
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 2) return null;
      const honmei = prediction.scored[0];
      const taikou = prediction.scored[1];
      return {
        raceId: race.id,
        kaisaiDate: race.kaisai_date,
        jocd: race.jocd,
        keirinjoName: race.keirinjo_name,
        raceNo: race.race_no,
        startTime: race.start_time,
        margin: honmei.totalScore - taikou.totalScore,
        honmeiCarNum: honmei.entry.car_num,
        honmeiName: honmei.entry.name,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  await saveDailyPicks(picks);
  console.log(`  保存: ${picks.length}件`);
}

async function main() {
  const today = todayJstStr();
  const tomorrow = addDaysToDateStr(today, 1);
  const start = Date.now();
  await processDate(today);
  await processDate(tomorrow);
  console.log(`完了 (${Date.now() - start}ms)`);
}

main();
