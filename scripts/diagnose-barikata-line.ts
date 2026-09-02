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
 * diagnose-barikata.tsの続き。ユーザー指摘「ライン決着が多いよね」を受けて、
 * 「予想1-2-3位（スコア順）が同じラインかどうか」を「バリカタ」判定に
 * 追加できるか検証する。ライン決着（同じラインが1-2-3を占める）は、
 * 実際の決まり手としても典型的な堅い決着パターンのため、単純なmargin以上に
 * 効く可能性がある。
 */

interface Rec {
  margin: number;
  sameLine: boolean; // 予想1-2-3位が同じライングループか
  actualSameLineTop3: boolean; // 実際の1-2-3着が同じラインだったか（参考）
  hit: boolean; // 予想1-2-3位の並びが実際と一致したか
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

        const actualCars = top3.map((r) => r.car_num);
        const carToLine = new Map(scored.map((s) => [s.entry.car_num, s.entry.line_group]));
        const actualLines = actualCars.map((c) => carToLine.get(c));
        const actualSameLineTop3 =
          actualLines[0] != null && actualLines[0] === actualLines[1] && actualLines[1] === actualLines[2];

        const rec: Rec = { margin, sameLine, actualSameLineTop3, hit, oddsWhenHit: hitOdds };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }

  console.log(`\npredictRace成功: ${records.length}件\n`);

  // 実際の決まり手としての「ライン決着」率（参考）
  const actualLineSweep = records.filter((r) => r.actualSameLineTop3).length;
  console.log(`■ 実際の1-2-3着が同じラインだった割合: ${((actualLineSweep / records.length) * 100).toFixed(1)}% (${actualLineSweep}/${records.length})\n`);

  // margin帯 × 予想1-2-3位が同じラインかどうか、で「的中かつ2倍台前半」を見る
  const buckets = [
    { label: "10-15", min: 10, max: 15 },
    { label: "15-20", min: 15, max: 20 },
    { label: "20+", min: 20, max: Infinity },
  ];
  console.log("margin帯 × 予想1-2-3位が同ラインか | 件数 | 的中率 | 的中時平均オッズ | 的中時2倍台前半率");
  for (const b of buckets) {
    for (const sameLine of [true, false]) {
      const recs = records.filter((r) => r.margin >= b.min && r.margin < b.max && r.sameLine === sameLine);
      if (recs.length === 0) continue;
      const hits = recs.filter((r) => r.hit);
      const oddsList = hits.map((r) => r.oddsWhenHit).filter((o): o is number => o != null);
      const avgOdds = oddsList.length > 0 ? oddsList.reduce((s, o) => s + o, 0) / oddsList.length : null;
      const inRange = oddsList.filter((o) => o >= 2.0 && o < 3.0).length;
      console.log(
        `  ${b.label} × ${sameLine ? "同ライン" : "別ライン混在"}: ${recs.length}件 ` +
          `的中率${((hits.length / recs.length) * 100).toFixed(1)}% (${hits.length}/${recs.length}) ` +
          `平均オッズ${avgOdds?.toFixed(2) ?? "-"}倍 ` +
          `2倍台前半率${oddsList.length > 0 ? ((inRange / oddsList.length) * 100).toFixed(1) : "-"}% (${inRange}/${oddsList.length})`
      );
    }
  }

  console.log("\n■ 累積：「的中かつ2倍台前半」率（margin下限 × 同ライン限定）:");
  for (const minMargin of [8, 10, 12, 15]) {
    const recs = records.filter((r) => r.margin >= minMargin && r.sameLine);
    const barikataHits = recs.filter(
      (r) => r.hit && r.oddsWhenHit != null && r.oddsWhenHit >= 2.0 && r.oddsWhenHit < 3.0
    );
    console.log(
      `  margin>=${minMargin} かつ同ライン: ${recs.length}件中、的中かつ2倍台前半: ${barikataHits.length}件 (${recs.length > 0 ? ((barikataHits.length / recs.length) * 100).toFixed(1) : "-"}%)`
    );
  }
}

main();
