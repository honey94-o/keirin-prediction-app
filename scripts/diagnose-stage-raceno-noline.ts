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
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, enableReadCache } from "../lib/repository";

/**
 * 新規候補3件の検証（新規スクレイピング不要）:
 *   1. レースの位置づけ（予選/準決勝/決勝等、syumokuから判定）別の◎的中率・回収率
 *   2. レース番号（1R〜）別の◎的中率・回収率
 *   3. 並び予想の有無（line_group未提供のレース）別の◎的中率・回収率
 */

function stageOf(syumoku: string | null): string {
  if (!syumoku) return "不明";
  if (/決勝/.test(syumoku) && !/準々|準決/.test(syumoku)) return "決勝";
  if (/準決勝/.test(syumoku)) return "準決勝";
  if (/準々決勝/.test(syumoku)) return "準々決勝";
  if (/選抜|特選/.test(syumoku)) return "選抜・特選";
  if (/予選/.test(syumoku)) return "予選";
  if (/一般/.test(syumoku)) return "一般";
  return "その他";
}

async function main() {
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id, ra.race_no, ra.syumoku FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number; race_no: number; syumoku: string | null }[];
  console.log(`対象レース: ${races.length}件`);

  const stageStats = new Map<string, { n: number; hit: number; stake: number; payout: number }>();
  const raceNoStats = new Map<number, { n: number; hit: number; stake: number; payout: number }>();
  const lineStats = new Map<string, { n: number; hit: number; stake: number; payout: number }>();

  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 2) return;
        const { scored, scenarios } = prediction;
        const honmeiScenario = scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario) return;

        const raceResults = await getResultsForRace(race.id);
        const top3 = raceResults
          .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
          .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
        if (top3.length < 3) return;

        const odds = (await getOddsForRace(race.id)).filter((o) => o.bet_type === "3連単");
        const distinctCombos = new Set(odds.map((o) => o.combination));
        const officialCombo = distinctCombos.size === 1 ? odds[0].combination : null;
        const actualCombo = officialCombo ?? top3.map((r) => r.car_num).join("-");
        const hitOdds = odds.find((o) => o.combination === actualCombo)?.odds_value ?? null;

        const stake = 100 * honmeiScenario.formation.combinations.length;
        const hit = honmeiScenario.formation.combinations.includes(actualCombo);
        const payout = hit && hitOdds != null ? 100 * hitOdds : 0;

        // 1. ステージ
        const stage = stageOf(race.syumoku);
        const s1 = stageStats.get(stage) ?? { n: 0, hit: 0, stake: 0, payout: 0 };
        s1.n++;
        if (hit) s1.hit++;
        s1.stake += stake;
        s1.payout += payout;
        stageStats.set(stage, s1);

        // 2. レース番号
        const s2 = raceNoStats.get(race.race_no) ?? { n: 0, hit: 0, stake: 0, payout: 0 };
        s2.n++;
        if (hit) s2.hit++;
        s2.stake += stake;
        s2.payout += payout;
        raceNoStats.set(race.race_no, s2);

        // 3. 並び予想の有無
        const hasLine = scored.some((sc) => sc.entry.line_group != null);
        const key = hasLine ? "並びあり" : "並びなし";
        const s3 = lineStats.get(key) ?? { n: 0, hit: 0, stake: 0, payout: 0 };
        s3.n++;
        if (hit) s3.hit++;
        s3.stake += stake;
        s3.payout += payout;
        lineStats.set(key, s3);
      })
    );
  }

  function printStats(title: string, map: Map<string | number, { n: number; hit: number; stake: number; payout: number }>) {
    console.log(`\n■ ${title}`);
    const entries = [...map.entries()].sort((a, b) => {
      if (typeof a[0] === "number" && typeof b[0] === "number") return a[0] - b[0];
      return String(a[0]).localeCompare(String(b[0]));
    });
    for (const [key, s] of entries) {
      const hitRate = ((s.hit / s.n) * 100).toFixed(1);
      const roi = s.stake > 0 ? ((s.payout / s.stake) * 100).toFixed(1) : "-";
      console.log(`  ${key}: ${s.n}件 的中率${hitRate}% (${s.hit}/${s.n}) 回収率${roi}%`);
    }
  }

  printStats("1. レースの位置づけ（本命シナリオ的中率・回収率）", stageStats);
  printStats("2. レース番号", raceNoStats);
  printStats("3. 並び予想の有無", lineStats);
}

main();
