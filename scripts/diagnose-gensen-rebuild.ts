import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
function loadEnv() {
  const p = path.join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    if (!(t.slice(0, i).trim() in process.env)) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
}
loadEnv();

import { getDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, resolveActualCombo, enableReadCache } from "../lib/repository";
import { raceStage } from "../lib/scoring";

/**
 * 厳選（毎日 margin>=10 の上位10件、本命フォーメーションを全部買い）を、
 * 更新後のlib/scoring.ts（honmeiFormationHighMargin）で作り直し、
 * その日の選び方（margin DESC / margin ASC / 10-13帯優先）でROIがどう変わるかを
 * daily_picksの実在33日分で再シミュレーションする。
 * ユーザー指摘「厳選の回収率悪すぎる／点数減らせ」への最終確認。
 */
const MIN_MARGIN = 10;
const PER_DAY = 10;

async function main() {
  enableReadCache();
  const db = getDb();
  const dayRows = await db.execute(
    `SELECT DISTINCT kaisai_date FROM daily_picks ORDER BY kaisai_date`
  );
  const days = (dayRows.rows as unknown as { kaisai_date: string }[]).map((r) => r.kaisai_date);

  type P = { raceId: number; date: string; margin: number; combos: string[]; actual: string | null; odds: number | null };
  const perDay = new Map<string, P[]>();

  for (const date of days) {
    const rs = await db.execute({
      sql: `SELECT dp.race_id FROM daily_picks dp WHERE dp.kaisai_date = ?`,
      args: [date],
    });
    const raceIds = (rs.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
    const list: P[] = [];
    const BATCH = 6;
    for (let i = 0; i < raceIds.length; i += BATCH) {
      const out = await Promise.all(
        raceIds.slice(i, i + BATCH).map(async (raceId) => {
          const p = await predictRace(raceId);
          if (!p || p.scored.length < 3 || p.scored.length === 9) return null;
          if (raceStage(p.race.syumoku) === "予選") return null;
          const margin = p.scored[0].totalScore - p.scored[1].totalScore;
          if (margin < MIN_MARGIN) return null;
          const combos = p.scenarios.find((s) => s.label === "本命")?.formation.combinations ?? [];
          if (combos.length === 0) return null;
          const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
          const actual = resolveActualCombo(results, odds);
          const oddsVal = actual
            ? odds.find((o) => o.bet_type === "3連単" && o.combination === actual)?.odds_value ?? null
            : null;
          return { raceId, date, margin, combos, actual, odds: oddsVal } as P;
        })
      );
      for (const r of out) if (r) list.push(r);
    }
    perDay.set(date, list);
  }

  function sim(name: string, pick: (a: P, b: P) => number) {
    let stake = 0, pay = 0, hit = 0, races = 0, pts = 0, finished = 0;
    for (const [, list] of perDay) {
      const chosen = [...list].sort(pick).slice(0, PER_DAY);
      for (const p of chosen) {
        races++;
        pts += p.combos.length;
        stake += 100 * p.combos.length;
        if (p.actual == null || p.odds == null) continue;
        finished++;
        if (p.combos.includes(p.actual)) {
          hit++;
          pay += 100 * p.odds;
        }
      }
    }
    console.log(
      `  ${name.padEnd(24)} ${races}R(確定${finished}) 平均${(pts / races).toFixed(1)}点 的中${((hit / finished) * 100).toFixed(1)}% 回収${((pay / stake) * 100).toFixed(1)}% 損益${Math.round(pay - stake)}円`
    );
  }

  console.log(`\n厳選再シミュレーション（${days[0]}〜${days.at(-1)}、${days.length}日、更新後スコアリング）\n`);
  sim("現行: margin降順", (a, b) => b.margin - a.margin);
  sim("margin昇順", (a, b) => a.margin - b.margin);
  sim("10-13帯優先→margin降順", (a, b) => {
    const band = (m: number) => (m < 13 ? 0 : 1);
    return band(a.margin) - band(b.margin) || b.margin - a.margin;
  });
}
main();
