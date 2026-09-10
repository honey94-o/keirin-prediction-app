import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    if (!(t.slice(0, i).trim() in process.env)) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, resolveActualCombo, enableReadCache } from "../lib/repository";
import { raceStage, buildLineAwarePool, HIGH_CONFIDENCE_MARGIN } from "../lib/scoring";

/**
 * lib/scoring.tsのhonmeiFormationHighMargin（margin>=10の本命買い目を帯別に
 * 点数・形を変える新ルール）を、実際のpredictRace経由で検証する。
 * 旧ルール（一律formationFromPool 20点）と同じレース集合で回収率を突き合わせる。
 * scratchpadでのオフライン近似（predictions由来）ではなく、本物の
 * buildLineAwarePoolの並びで確認するのが目的。
 */
function oldFormation(axis: number, pool: number[]): string[] {
  const combos: string[] = [];
  let poolSize = 2;
  for (let m = 2; m <= pool.length; m++) {
    if (m * (m - 1) > 20) break;
    poolSize = m;
  }
  const cs = pool.slice(0, poolSize);
  for (const s of cs) for (const t of cs) if (s !== t) combos.push(`${axis}-${s}-${t}`);
  return combos;
}

async function main() {
  enableReadCache();
  const db = getDb();
  const res = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r JOIN races ra ON ra.id=r.race_id
     WHERE r.finish_pos IS NOT NULL AND ra.encp LIKE 'wt:%' ORDER BY r.race_id`
  );
  let ids = (res.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const lim = process.argv.find((a) => a.startsWith("--limit="));
  if (lim) ids = ids.slice(-Number(lim.split("=")[1]));
  console.log(`候補: ${ids.length}件`);

  type Rec = { date: string; margin: number; newLen: number; oldLen: number; newHit: boolean; oldHit: boolean; odds: number };
  const recs: Rec[] = [];
  const BATCH = 6;
  for (let i = 0; i < ids.length; i += BATCH) {
    const out = await Promise.all(
      ids.slice(i, i + BATCH).map(async (raceId) => {
        const p = await predictRace(raceId);
        if (!p || p.scored.length < 3 || p.scored.length === 9) return null;
        if (raceStage(p.race.syumoku) === "予選") return null;
        const margin = p.scored[0].totalScore - p.scored[1].totalScore;
        if (margin < HIGH_CONFIDENCE_MARGIN) return null;
        const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
        const actual = resolveActualCombo(results, odds);
        if (!actual) return null;
        const oddsVal = odds.find((o) => o.bet_type === "3連単" && o.combination === actual)?.odds_value ?? null;
        if (oddsVal == null) return null;
        const honmei = p.scored[0];
        const newCombos = p.scenarios.find((s) => s.label === "本命")?.formation.combinations ?? [];
        const pool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, p.scored);
        const oldCombos = oldFormation(honmei.entry.car_num, pool);
        return {
          date: p.race.kaisai_date,
          margin,
          newLen: newCombos.length,
          oldLen: oldCombos.length,
          newHit: newCombos.includes(actual),
          oldHit: oldCombos.includes(actual),
          odds: oddsVal,
        } as Rec;
      })
    );
    for (const r of out) if (r) recs.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }

  const dates = [...new Set(recs.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  function agg(label: string, sub: Rec[]) {
    const f = (pick: "new" | "old") => {
      let stake = 0, pay = 0, hit = 0, pts = 0;
      for (const r of sub) {
        const len = pick === "new" ? r.newLen : r.oldLen;
        const h = pick === "new" ? r.newHit : r.oldHit;
        pts += len; stake += 100 * len;
        if (h) { hit++; pay += 100 * r.odds; }
      }
      return `平均${(pts / sub.length).toFixed(1)}点 的中${((hit / sub.length) * 100).toFixed(1)}% 回収${((pay / stake) * 100).toFixed(1)}% 損益${Math.round(pay - stake)}円`;
    };
    console.log(`[${label}] n=${sub.length}`);
    console.log(`  旧(一律20): ${f("old")}`);
    console.log(`  新ルール  : ${f("new")}`);
  }
  console.log(`\n厳選対象: ${recs.length}件  train ${dates[0]}〜${split} / test 〜${dates.at(-1)}\n`);
  agg("全体", recs);
  agg("train", recs.filter((r) => r.date < split));
  agg("test", recs.filter((r) => r.date >= split));
  agg("margin 10-13", recs.filter((r) => r.margin < 13));
  agg("margin >=13", recs.filter((r) => r.margin >= 13));
}
main();
