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
import { getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";

/**
 * ユーザー質問「厳選レースで本命が外れた時、2・3着を厳選し直せば当たったのでは？」
 * への回答用。
 *
 * 「本命」シナリオは3連単フォーメーションで軸（◎＝総合スコア1位）を常に1着固定
 * にしているため、◎が実際の1着でなければ2・3着の組み合わせをどう選んでも
 * 原理的に当たらない。外れたレースを
 *   (A) 軸的中・組み合わせ外れ（◎は1着だったが実際の2・3着ペアがフォーメーション外）
 *   (B) 軸不的中（◎がそもそも1着になれなかった）
 * に分解し、(B)についてはpredictRaceが同時に生成している他シナリオ
 * （逃げ粘り込み／まくり・差し一撃／単騎一撃）のどれかが実際の結果を
 * 当てていたか（＝軸選びを変えていれば拾えたか）を確認する。
 */

const TOP_K = 10; // 現行の厳選ロジックと同じ

interface RaceRecord {
  date: string;
  raceId: number;
  keirinjoName: string;
  raceNo: number;
  margin: number;
  honmeiAxis: number;
  honmeiCombos: string[];
  otherScenarios: { label: string; axisCarNum: number; combos: string[] }[];
  actualCombo: string;
  actualWinner: number;
  hit: boolean;
}

async function loadRecords(): Promise<RaceRecord[]> {
  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date, ra.keirinjo_name, ra.race_no FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as {
    id: number;
    kaisai_date: string;
    keirinjo_name: string;
    race_no: number;
  }[];

  const records: RaceRecord[] = [];
  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 2) return null;
        const { scored, scenarios } = prediction;
        const honmeiScenario = scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario) return null;

        const raceResults = await getResultsForRace(race.id);
        const top3 = raceResults
          .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
          .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
        if (top3.length < 3) return null;

        const odds = (await getOddsForRace(race.id)).filter((o) => o.bet_type === "3連単");
        const distinctCombos = new Set(odds.map((o) => o.combination));
        const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
        const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");

        const margin = scored[0].totalScore - scored[1].totalScore;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);

        const rec: RaceRecord = {
          date: race.kaisai_date,
          raceId: race.id,
          keirinjoName: race.keirinjo_name,
          raceNo: race.race_no,
          margin,
          honmeiAxis: honmeiScenario.axisCarNum,
          honmeiCombos: honmeiScenario.formation.combinations,
          otherScenarios: scenarios
            .filter((s) => s.label !== "本命")
            .map((s) => ({ label: s.label, axisCarNum: s.axisCarNum, combos: s.formation.combinations })),
          actualCombo,
          actualWinner: top3[0].car_num,
          hit,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }
  return records;
}

function selectDaily(records: RaceRecord[]): RaceRecord[] {
  const byDate = new Map<string, RaceRecord[]>();
  for (const r of records) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const selected: RaceRecord[] = [];
  for (const races of byDate.values()) {
    selected.push(...[...races].sort((a, b) => b.margin - a.margin).slice(0, TOP_K));
  }
  return selected;
}

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const all = await loadRecords();
  const selected = selectDaily(all);
  console.log(`厳選（日次margin上位${TOP_K}件）選定レース: ${selected.length}件`);

  const hits = selected.filter((r) => r.hit);
  const misses = selected.filter((r) => !r.hit);
  console.log(`的中: ${hits.length}件 / 不的中: ${misses.length}件 (的中率${((hits.length / selected.length) * 100).toFixed(1)}%)\n`);

  const axisWonButComboMissed = misses.filter((r) => r.actualWinner === r.honmeiAxis);
  const axisLost = misses.filter((r) => r.actualWinner !== r.honmeiAxis);

  console.log(`■ 不的中${misses.length}件の内訳:`);
  console.log(
    `  (A) 軸(◎)は1着的中・2/3着の組み合わせが外れ: ${axisWonButComboMissed.length}件 ` +
      `(${((axisWonButComboMissed.length / misses.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  (B) 軸(◎)がそもそも1着になれず: ${axisLost.length}件 ` +
      `(${((axisLost.length / misses.length) * 100).toFixed(1)}%) ` +
      `※2・3着をどう選んでも「本命」シナリオでは原理的に当たらない\n`
  );

  // (B) について、他シナリオ（逃げ粘り込み/まくり差し一撃/単騎一撃）のどれかが
  // 実際の結果を当てていたか
  let wouldHaveHitByOtherScenario = 0;
  const hitByLabel = new Map<string, number>();
  for (const r of axisLost) {
    const hitScenario = r.otherScenarios.find((s) => s.combos.includes(r.actualCombo));
    if (hitScenario) {
      wouldHaveHitByOtherScenario++;
      hitByLabel.set(hitScenario.label, (hitByLabel.get(hitScenario.label) ?? 0) + 1);
    }
  }
  console.log(`■ (B)軸不的中${axisLost.length}件のうち、他シナリオ（同時生成済み）が実際の結果を当てていたケース:`);
  console.log(
    `  ${wouldHaveHitByOtherScenario}件 (${((wouldHaveHitByOtherScenario / axisLost.length) * 100).toFixed(1)}%) ` +
      `※もし軸選び自体を変えていれば拾えていた可能性がある件数`
  );
  for (const [label, count] of hitByLabel) {
    console.log(`    - ${label}が的中していた: ${count}件`);
  }
  console.log(
    `  → 残り${axisLost.length - wouldHaveHitByOtherScenario}件は、生成済みのどのシナリオ（軸候補）でも` +
      `実際の勝者を軸にできておらず、後知恵でも拾えなかったレース`
  );

  console.log(`\n■ (A)軸的中・組み合わせ外れ ${axisWonButComboMissed.length}件の例（margin降順、上位10件）:`);
  const sortedA = [...axisWonButComboMissed].sort((a, b) => b.margin - a.margin).slice(0, 10);
  for (const r of sortedA) {
    console.log(
      `  ${r.date} ${r.keirinjoName}${r.raceNo}R: 買い目軸${r.honmeiAxis} 実際${r.actualCombo} ` +
        `(margin${r.margin.toFixed(1)}, 買い目候補: ${r.honmeiCombos.length}点)`
    );
  }
}

main();
