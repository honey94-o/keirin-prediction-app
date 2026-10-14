/**
 * ローカルSQLite（dump-to-sqlite.ts）に対して本番と同一のpredictRace()を全確定レースで
 * 実行し、2・3着研究用のキャッシュ scripts/data/scored-cache.json を作る。
 * 以後の仮説検証はこのJSONだけを読めばよく、DBには一切アクセスしない。
 * 使い方: npx tsx scripts/local-db/build-scored-cache.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { useLocalDb } from "../lib/local-db";
import { predictRace } from "../../lib/predict";
import { buildLineAwarePool } from "../../lib/scoring";

const db = useLocalDb();

interface CachedEntry {
  car: number;
  snum: string;
  totalScore: number;
  lineScore: number;
  kyakuScore: number;
  statsScore: number;
  lineGroup: number | null;
  linePos: string | null;
  kyaku: string | null;
  tokuten: number | null;
  classRank: string | null;
  nige: number | null;
  makuri: number | null;
  sashi: number | null;
  mark: number | null;
  standing: number | null;
  backLead: number | null;
  homeLead: number | null;
  syouritu: number | null;
  ren2: number | null;
  ren3: number | null;
  gear: number | null;
  finish: number | null;
  kimarite: string | null;
}

async function main() {
  const races = db
    .prepare(
      `SELECT r.id, r.kaisai_date, r.jocd, r.keirinjo_name, r.race_no, r.grade_kbn, r.syumoku, r.start_time
       FROM races r
       WHERE (SELECT COUNT(*) FROM results x WHERE x.race_id = r.id AND x.finish_pos BETWEEN 1 AND 3) >= 3
       ORDER BY r.kaisai_date, r.id`
    )
    .all() as {
    id: number;
    kaisai_date: string;
    jocd: string;
    keirinjo_name: string;
    race_no: number;
    grade_kbn: string | null;
    syumoku: string | null;
    start_time: string | null;
  }[];
  console.log(`確定レース ${races.length}件`);

  const resultStmt = db.prepare("SELECT car_num, finish_pos, kimarite FROM results WHERE race_id = ?");
  const oddsStmt = db.prepare("SELECT combination, odds_value, ninki FROM odds WHERE race_id = ? AND bet_type = '3連単'");

  const out: unknown[] = [];
  const started = Date.now();
  for (let i = 0; i < races.length; i++) {
    const race = races[i];
    const prediction = await predictRace(race.id);
    if (!prediction || prediction.scored.length < 3) continue;

    const results = resultStmt.all(race.id) as { car_num: number; finish_pos: number | null; kimarite: string | null }[];
    const finishByCar = new Map(results.map((r) => [r.car_num, r]));
    const top3 = [...results]
      .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
      .sort((a, b) => a.finish_pos! - b.finish_pos!);
    const actual = top3.map((r) => r.car_num).join("-");
    const deadHeat = new Set(top3.map((r) => r.finish_pos)).size < top3.length;
    const odds = oddsStmt.all(race.id) as { combination: string; odds_value: number; ninki: number | null }[];
    const hitOdds = odds.find((o) => o.combination === actual);

    const scored = prediction.scored;
    const honmei = scored[0];
    const entries: CachedEntry[] = scored.map((s) => {
      const e = s.entry;
      const res = finishByCar.get(e.car_num);
      return {
        car: e.car_num,
        snum: e.snum,
        totalScore: s.totalScore,
        lineScore: s.lineScore.score,
        kyakuScore: s.kyakushitsuScore.score,
        statsScore: s.statsScore.score,
        lineGroup: e.line_group,
        linePos: e.line_position,
        kyaku: e.kyakushitsu,
        tokuten: e.heikin_tokuten,
        classRank: e.class_rank,
        nige: e.kimarite_nige_count,
        makuri: e.kimarite_makuri_count,
        sashi: e.kimarite_sashi_count,
        mark: e.kimarite_mark_count,
        standing: e.standing_count,
        backLead: e.back_lead_count,
        homeLead: e.home_lead_count,
        syouritu: e.syouritu,
        ren2: e.rentairitu2,
        ren3: e.rentairitu3,
        gear: e.gear_ratio,
        finish: res?.finish_pos ?? null,
        kimarite: res?.kimarite ?? null,
      };
    });

    out.push({
      raceId: race.id,
      date: race.kaisai_date,
      jocd: race.jocd,
      venue: race.keirinjo_name,
      raceNo: race.race_no,
      grade: race.grade_kbn,
      syumoku: race.syumoku,
      startTime: race.start_time,
      girls: scored.some((s) => s.entry.class_rank?.startsWith("L")),
      margin: honmei.totalScore - scored[1].totalScore,
      entries, // totalScore降順（scored順）
      honmeiPool: buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored),
      scenarios: prediction.scenarios.map((sc) => ({
        label: sc.label,
        axis: sc.axisCarNum,
        combos: sc.formation.combinations,
      })),
      actual,
      deadHeat,
      payout: hitOdds ? Math.round(hitOdds.odds_value * 100) : null,
      payoutNinki: hitOdds?.ninki ?? null,
      hasOdds: odds.length > 0,
    });

    if ((i + 1) % 500 === 0) {
      const sec = (Date.now() - started) / 1000;
      console.log(`${i + 1}/${races.length} (${sec.toFixed(0)}s)`);
    }
  }

  const outPath = path.join(process.cwd(), "scripts", "data", "scored-cache.json");
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`書き出し ${out.length}件 → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
