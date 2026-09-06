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
 * diagnose-barikata-line.tsの続き。「別ライン混在」(sameLine=false)の中でも、
 * ユーザー提案「予想1-2位だけでも同ラインで強ければ候補漏れとして拾えないか」を検証する。
 * sameLine=falseをさらに「top2SameLine」（予想1-2位が同ライン、3位が別/単騎）と
 * 「それ以外（1-2位すら別ライン）」に分け、単一の並び（1-2-3位そのまま）の
 * 的中率・オッズを比較する。
 */

interface Rec {
  margin: number;
  sameLine: boolean;
  top2SameLine: boolean; // sameLine=falseの中で、予想1-2位だけは同ラインか
  hit: boolean;
  oddsWhenHit: number | null;
}

async function main() {
  enableReadCache();

  const db = getDb();
  const raceRows = await db.execute(`
    SELECT ra.id FROM races ra
    JOIN results res ON res.race_id = ra.id AND res.finish_pos = 1
    ORDER BY ra.kaisai_date, ra.id
  `);
  const races = raceRows.rows as unknown as { id: number }[];
  console.log(`対象レース: ${races.length}件`);

  const records: Rec[] = [];
  const BATCH = 60;
  for (let i = 0; i < races.length; i += BATCH) {
    const batch = races.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (race) => {
        const prediction = await predictRace(race.id);
        if (!prediction || prediction.scored.length < 3) return null;
        const { scored } = prediction;

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
        const topCombo = `${scored[0].entry.car_num}-${scored[1].entry.car_num}-${scored[2].entry.car_num}`;
        const hit = topCombo === actualCombo;
        const hitOdds = hit ? (odds.find((o) => o.combination === actualCombo)?.odds_value ?? null) : null;

        const lg0 = scored[0].entry.line_group;
        const lg1 = scored[1].entry.line_group;
        const lg2 = scored[2].entry.line_group;
        const sameLine = lg0 != null && lg0 === lg1 && lg1 === lg2;
        const top2SameLine = !sameLine && lg0 != null && lg0 === lg1;

        const rec: Rec = { margin, sameLine, top2SameLine, hit, oddsWhenHit: hitOdds };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }

  console.log(`\npredictRace成功: ${records.length}件\n`);

  const buckets = [
    { label: "8-10", min: 8, max: 10 },
    { label: "10-15", min: 10, max: 15 },
    { label: "15-20", min: 15, max: 20 },
    { label: "20+", min: 20, max: Infinity },
  ];
  console.log("margin帯 × 予想1-2-3位の関係 | 件数 | 的中率 | 的中時平均オッズ | 的中時2倍台前半率");
  for (const b of buckets) {
    const groups: { label: string; filter: (r: Rec) => boolean }[] = [
      { label: "1-2-3位同ライン", filter: (r) => r.sameLine },
      { label: "1-2位のみ同ライン(3位別/単騎)", filter: (r) => r.top2SameLine },
      { label: "1-2位すら別ライン", filter: (r) => !r.sameLine && !r.top2SameLine },
    ];
    for (const g of groups) {
      const recs = records.filter((r) => r.margin >= b.min && r.margin < b.max && g.filter(r));
      if (recs.length === 0) continue;
      const hits = recs.filter((r) => r.hit);
      const oddsList = hits.map((r) => r.oddsWhenHit).filter((o): o is number => o != null);
      const avgOdds = oddsList.length > 0 ? oddsList.reduce((s, o) => s + o, 0) / oddsList.length : null;
      const inRange = oddsList.filter((o) => o >= 2.0 && o < 3.0).length;
      console.log(
        `  ${b.label} × ${g.label}: ${recs.length}件 ` +
          `的中率${((hits.length / recs.length) * 100).toFixed(1)}% (${hits.length}/${recs.length}) ` +
          `平均オッズ${avgOdds?.toFixed(2) ?? "-"}倍 ` +
          `2倍台前半率${oddsList.length > 0 ? ((inRange / oddsList.length) * 100).toFixed(1) : "-"}% (${inRange}/${oddsList.length})`
      );
    }
  }

  console.log("\n■ 累積（margin>=8での3区分比較）:");
  const cumGroups: { label: string; filter: (r: Rec) => boolean }[] = [
    { label: "1-2-3位同ライン", filter: (r) => r.sameLine },
    { label: "1-2位のみ同ライン", filter: (r) => r.top2SameLine },
    { label: "1-2位すら別ライン", filter: (r) => !r.sameLine && !r.top2SameLine },
  ];
  for (const g of cumGroups) {
    const recs = records.filter((r) => r.margin >= 8 && g.filter(r));
    const hits = recs.filter((r) => r.hit);
    console.log(`  ${g.label}: ${recs.length}件 的中率${recs.length > 0 ? ((hits.length / recs.length) * 100).toFixed(1) : "-"}% (${hits.length}/${recs.length})`);
  }
}

main();
