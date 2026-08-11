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

// 「毎日margin上位10件」で選んだレースの中で、本命フォーメーションの点数帯
// （＝marginの水準）によって実際のROIがどう違うかを見る。
// ユーザー指摘：「タブ画面に出てる買い目でいいの？1レース6点とかだけど」への回答用。

interface Rec {
  date: string;
  margin: number;
  points: number;
  stake: number;
  payout: number;
  hit: boolean;
}

async function main() {
  // 同じ選手・開催場の集計をレースごとに引き直すのを防ぐ（Turso の読取行数削減）。
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.kaisai_date FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; kaisai_date: string }[];
  console.log(`対象レース: ${races.length}件`);

  const records: Rec[] = [];
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
        const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

        const margin = scored[0].totalScore - scored[1].totalScore;
        const points = honmeiScenario.formation.combinations.length;
        const stake = 100 * points;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;

        const rec: Rec = { date: race.kaisai_date, margin, points, stake, payout, hit };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }
  console.log(`predictRace成功: ${records.length}件\n`);

  // 「毎日margin上位10件」の選定を再現
  const byDate = new Map<string, Rec[]>();
  for (const r of records) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const selected: Rec[] = [];
  for (const [, races] of byDate) {
    const top10 = [...races].sort((a, b) => b.margin - a.margin).slice(0, 10);
    selected.push(...top10);
  }
  console.log(`選定されたレース総数: ${selected.length}件\n`);

  // 点数帯（実際のフォーメーション点数）でグルーピング
  const byPoints = new Map<number, { races: number; hits: number; stake: number; payout: number }>();
  for (const r of selected) {
    const agg = byPoints.get(r.points) ?? { races: 0, hits: 0, stake: 0, payout: 0 };
    agg.races++;
    if (r.hit) agg.hits++;
    agg.stake += r.stake;
    agg.payout += r.payout;
    byPoints.set(r.points, agg);
  }
  console.log("=== 選定レースを実際のフォーメーション点数別に集計 ===");
  for (const [points, agg] of [...byPoints.entries()].sort((a, b) => a[0] - b[0])) {
    const hitRate = ((agg.hits / agg.races) * 100).toFixed(1);
    const roi = agg.stake > 0 ? ((agg.payout / agg.stake) * 100).toFixed(1) : "-";
    console.log(
      `  ${points}点: 母数${agg.races}件 的中率${hitRate}% (${agg.hits}) 回収率${roi}% (賭け金${agg.stake}円/払戻${agg.payout.toFixed(0)}円)`
    );
  }

  // margin帯別にも見る（2点=margin>=10未満のformationFromPool挙動、20点=margin>=10、等）
  const bands: { label: string; test: (m: number) => boolean }[] = [
    { label: "margin<5 (拮抗ボックス)", test: (m) => m < 5 },
    { label: "5<=margin<10 (通常フォーメーション)", test: (m) => m >= 5 && m < 10 },
    { label: "margin>=10 (高信頼度・20点)", test: (m) => m >= 10 },
  ];
  console.log("\n=== 選定レースをmargin帯別に集計 ===");
  for (const band of bands) {
    const races = selected.filter((r) => band.test(r.margin));
    if (races.length === 0) {
      console.log(`  ${band.label}: 母数0件`);
      continue;
    }
    const hits = races.filter((r) => r.hit).length;
    const stake = races.reduce((s, r) => s + r.stake, 0);
    const payout = races.reduce((s, r) => s + r.payout, 0);
    const hitRate = ((hits / races.length) * 100).toFixed(1);
    const roi = stake > 0 ? ((payout / stake) * 100).toFixed(1) : "-";
    console.log(
      `  ${band.label}: 母数${races.length}件 的中率${hitRate}% (${hits}) 回収率${roi}% (賭け金${stake}円/払戻${payout.toFixed(0)}円)`
    );
  }
}

main();
