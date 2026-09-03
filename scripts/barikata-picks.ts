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
import { getRacesByDate, saveBarikataPicks, enableReadCache } from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * 「バリカタ」レース（scripts/diagnose-barikata.ts・-line.tsで検証済み）を
 * 1日最大3件選び、barikata_picksに保存する。ホーム画面「本日のバリカタ」用。
 *
 * 条件: margin(◎-対抗のスコア差)>=BARIKATA_MIN_MARGIN かつ
 * 予想1-2-3位（総合スコア順）が同じライングループ。この条件のレースは
 * 3連単フォーメーションではなく単一の並び（予想1-2-3位そのまま、1点=100円）の
 * 的中率が32.7%（margin単体条件の約2倍）、的中時平均オッズ4.13倍、
 * 1点買いの回収率は約140%だった（検証時点、n=197件）。
 * 条件を満たす日が無ければ0件でもよい（無理に3件揃えない）。
 */
const BARIKATA_MIN_MARGIN = 8;
const BARIKATA_MAX_PER_DAY = 3;

async function processDate(kaisaiDate: string): Promise<void> {
  const races = await getRacesByDate(kaisaiDate);
  console.log(`${kaisaiDate}: 対象レース${races.length}件`);
  if (races.length === 0) return;

  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));

  const candidates = races
    .map((race, i) => {
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 3) return null;
      // 9人立ては◎的中率が有意に低い（scripts/diagnose-fieldsize.ts、holdout検証済み）。
      // 単一の並びを1点買いするバリカタは的中率の影響がより直接効くため同様に除外する。
      if (prediction.scored.length === 9) return null;
      const { scored } = prediction;
      const honmei = scored[0];
      const taikou = scored[1];
      const margin = honmei.totalScore - taikou.totalScore;
      if (margin < BARIKATA_MIN_MARGIN) return null;

      const lg0 = scored[0].entry.line_group;
      const lg1 = scored[1].entry.line_group;
      const lg2 = scored[2].entry.line_group;
      const sameLine = lg0 != null && lg0 === lg1 && lg1 === lg2;
      if (!sameLine) return null;

      const combo = `${scored[0].entry.car_num}-${scored[1].entry.car_num}-${scored[2].entry.car_num}`;
      return {
        raceId: race.id,
        kaisaiDate: race.kaisai_date,
        jocd: race.jocd,
        keirinjoName: race.keirinjo_name,
        raceNo: race.race_no,
        startTime: race.start_time,
        margin,
        combo,
        honmeiCarNum: honmei.entry.car_num,
        honmeiName: honmei.entry.name,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  const picks = [...candidates].sort((a, b) => b.margin - a.margin).slice(0, BARIKATA_MAX_PER_DAY);

  await saveBarikataPicks(picks);
  console.log(`  条件を満たすレース: ${candidates.length}件 → 保存: ${picks.length}件`);
}

async function main() {
  enableReadCache();

  const today = todayJstStr();
  const tomorrow = addDaysToDateStr(today, 1);
  const start = Date.now();
  await processDate(today);
  await processDate(tomorrow);
  console.log(`完了 (${Date.now() - start}ms)`);
}

main();
