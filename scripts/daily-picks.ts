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
import { raceStage } from "../lib/scoring";
import { getRacesByDate, saveDailyPicks, enableReadCache } from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * 結果未確定（これから走る）レースの◎-対抗スコア差を計算し、daily_picksに保存する。
 * ホーム画面「本日の厳選レース」・/picks画面の元データ。当日・翌日（ホーム画面の
 * 2タブ分）の全レース分のmarginをここでは絞らずに保存し、実際に「上位10件だけ
 * 表示する」という絞り込みはlib/repository.tsのgetDailyPicks側で行う
 * （scripts/simulate-selective-strategy.tsの検証結果に基づく）。
 * daily-sync.yml実行のたびに呼ぶため、日中にオッズ・並び予想が更新されればその都度
 * 最新の予想に更新される。
 *
 * 予選レースはscripts/diagnose-stage-holdout.tsで検証済みの理由（raceStageの
 * コメント参照）により、厳選の候補から除外する（daily_picksに保存しない＝
 * getDailyPicksの「上位10件」選定に混ざらない）。
 * 9人立てレースもscripts/diagnose-fieldsize.tsで検証済み（predictions実績、
 * 予選を除いた上でも◎単勝的中率が9人立て27.6-30.0%・それ以外44.4-44.9%と
 * 大きく低く、train/testホールドアウトでも再現）のため同様に除外する。
 */
async function processDate(kaisaiDate: string): Promise<void> {
  const races = await getRacesByDate(kaisaiDate);
  console.log(`${kaisaiDate}: 対象レース${races.length}件`);
  if (races.length === 0) return;

  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));

  const picks = races
    .map((race, i) => {
      if (raceStage(race.syumoku) === "予選") return null;
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 2) return null;
      if (prediction.scored.length === 9) return null;
      const honmei = prediction.scored[0];
      const taikou = prediction.scored[1];
      const honmeiScenario = prediction.scenarios.find((s) => s.label === "本命");
      if (!honmeiScenario) return null;
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
        // その日実際に見せた買い目のスナップショット。後でスコアリングロジックを
        // 変更しても「前日の結果」表示が過去に遡って変わらないようにするため。
        formation: honmeiScenario.formation.combinations,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  await saveDailyPicks(picks);
  console.log(`  保存: ${picks.length}件`);
}

async function main() {
  // 同じ選手・開催場の集計を全レースぶん引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const today = todayJstStr();
  const tomorrow = addDaysToDateStr(today, 1);
  const start = Date.now();
  await processDate(today);
  await processDate(tomorrow);
  console.log(`完了 (${Date.now() - start}ms)`);
}

main();
