import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { predictRace } from "../lib/predict";
import { enableReadCache } from "../lib/repository";

// next dev/buildは.env.localを自動で読むが、tsx単体では読まれないため手動でロードする。
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

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const raceId = Number(process.argv[2] ?? 1);

  const prediction = await predictRace(raceId);
  if (!prediction) {
    console.error(`race id ${raceId} not found`);
    process.exit(1);
  }

  const { race, bankInfo, scored, scenarios, boxSuggestion } = prediction;

  console.log(`${race.keirinjo_name} ${race.race_no}R (${race.kaisai_date}) ${race.syumoku ?? ""}`);
  if (bankInfo) {
    console.log(
      `バンク: 周長${bankInfo.shuutyou}m 直線${bankInfo.tyokusen} ` +
        `決まり手(逃${bankInfo.nige_pct}% 捲${bankInfo.makuri_pct}% 差${bankInfo.sashi_pct}%)`
    );
  }
  console.log();

  for (const s of scored) {
    console.log(
      `${s.mark} 車番${s.entry.car_num} ${s.entry.name} 総合${s.totalScore.toFixed(1)} ` +
        `(ライン${s.lineScore.score.toFixed(0)} / 脚質実力${s.kyakushitsuScore.score.toFixed(0)} / データ統計${s.statsScore.score.toFixed(0)})`
    );
    console.log(`    ライン内訳: ${JSON.stringify(s.lineScore.factors)}`);
    console.log(`    脚質実力内訳: ${JSON.stringify(s.kyakushitsuScore.factors)}`);
    console.log(`    データ統計内訳: ${JSON.stringify(s.statsScore.factors)}`);
  }

  console.log();
  for (const scenario of scenarios) {
    console.log(`【${scenario.label}】軸 ${scenario.axisCarNum}.${scenario.axisName} - ${scenario.reason}`);
    console.log(`  ${scenario.formation.combinations.join(", ")}`);
  }
  if (boxSuggestion) {
    console.log();
    console.log(`${boxSuggestion.betType} (${boxSuggestion.combinations.length}点):`);
    console.log(`  ${boxSuggestion.combinations.join(", ")}`);
  }
}

main();
