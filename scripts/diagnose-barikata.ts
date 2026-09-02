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
 * ユーザー提案「バリカタレース（3連単オッズが2倍台前半になるような堅い決着）を
 * 1日2〜3レース厳選したい」の検証。事前オッズは使わない方針のため、自モデルの
 * margin（◎-対抗のスコア差）と、実際に確定した3連単配当の関係を見て、
 * 「このmargin帯なら高確率で単勝的中かつ低オッズ（＝堅い決着）になる」
 * 閾値を探す。
 *
 * 厳選（本命フォーメーション）とは別の切り口で、◎-2着-3着の「単一の
 * 最有力な並び」（スコア順の1点買い、フォーメーションではない）が的中したか、
 * 的中した場合の実オッズがどう分布するかを見る。
 */

interface Rec {
  margin: number;
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
        if (!prediction || prediction.scored.length < 2) return null;
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
        // スコア順1-2-3位の単一の並び（フォーメーションではなく1点買い相当）
        const topCombo = `${scored[0].entry.car_num}-${scored[1].entry.car_num}-${scored[2].entry.car_num}`;
        const hit = topCombo === actualCombo;
        const hitOdds = hit ? (odds.find((o) => o.combination === actualCombo)?.odds_value ?? null) : null;

        const rec: Rec = { margin, hit, oddsWhenHit: hitOdds };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
  }

  console.log(`\npredictRace成功: ${records.length}件\n`);

  const buckets = [
    { label: "10-15", min: 10, max: 15 },
    { label: "15-20", min: 15, max: 20 },
    { label: "20-25", min: 20, max: 25 },
    { label: "25-30", min: 25, max: 30 },
    { label: "30+", min: 30, max: Infinity },
  ];

  console.log("margin帯 | 件数 | 単一並び的中率 | 的中時平均オッズ | 的中時2倍台前半(2.0-2.9)の割合");
  for (const b of buckets) {
    const recs = records.filter((r) => r.margin >= b.min && r.margin < b.max);
    const hits = recs.filter((r) => r.hit);
    const oddsList = hits.map((r) => r.oddsWhenHit).filter((o): o is number => o != null);
    const avgOdds = oddsList.length > 0 ? oddsList.reduce((s, o) => s + o, 0) / oddsList.length : null;
    const inBarikataRange = oddsList.filter((o) => o >= 2.0 && o < 3.0).length;
    console.log(
      `  ${b.label}: ${recs.length}件 的中率${((hits.length / recs.length) * 100).toFixed(1)}% (${hits.length}/${recs.length}) ` +
        `平均オッズ${avgOdds?.toFixed(2) ?? "-"}倍 ` +
        `2倍台前半率${oddsList.length > 0 ? ((inBarikataRange / oddsList.length) * 100).toFixed(1) : "-"}% (${inBarikataRange}/${oddsList.length})`
    );
  }

  // 「的中し、かつ2倍台前半」を狙うなら、どのmargin以上が良いかの累積視点
  console.log("\n■ 累積視点（このmargin以上のレース全体で見た「的中かつ2倍台前半」率）:");
  for (const minMargin of [15, 20, 25, 30, 35]) {
    const recs = records.filter((r) => r.margin >= minMargin);
    const barikataHits = recs.filter((r) => r.hit && r.oddsWhenHit != null && r.oddsWhenHit >= 2.0 && r.oddsWhenHit < 3.0);
    console.log(
      `  margin>=${minMargin}: ${recs.length}件中、単一並び的中かつ2倍台前半: ${barikataHits.length}件 (${((barikataHits.length / recs.length) * 100).toFixed(1)}%)`
    );
  }
}

main();
