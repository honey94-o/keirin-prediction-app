/**
 * 本番移植（lib/second-third-model.ts winProbabilities + lib/predict.ts honmeiWinProb +
 * scripts/lib/picks.ts confidence）の確認。ローカルSQLiteで本番と同じpredictRace→buildPicksを
 * 全確定レースに通し、「確度高」（confidence >= BARIKATA_HIGH_CONFIDENCE）の件数・的中率が
 * 研究（scripts/research/barikata-hitrate.ts、固定T=0.14のin-sample: P1 31.9% / P2 47.6% / P3 48.5%）と
 * 整合するかを見る。
 */
import { useLocalDb } from "../lib/local-db";
import { predictRace } from "../../lib/predict";
import { BARIKATA_HIGH_CONFIDENCE } from "../../lib/second-third-model";
import { buildPicks } from "../lib/picks";
import { loadCache } from "../lib/research-cache";
import type { RaceRow } from "../../lib/types";

const db = useLocalDb();
const period = (d: string) => (d < "20260615" ? "P1" : d < "20260726" ? "P2" : "P3");

async function main() {
  const cache = new Map(loadCache().map((r) => [r.raceId, r]));
  const races = db.prepare("SELECT * FROM races ORDER BY kaisai_date, id").all() as unknown as RaceRow[];
  const byDate = new Map<string, RaceRow[]>();
  for (const r of races) if (cache.has(r.id)) (byDate.get(r.kaisai_date) ?? byDate.set(r.kaisai_date, []).get(r.kaisai_date)!).push(r);
  const stat: Record<string, { days: Set<string>; all: [number, number]; hi: [number, number] }> = {};
  for (const [date, dayRaces] of byDate) {
    const preds = await Promise.all(dayRaces.map((r) => predictRace(r.id)));
    const { barikataPicks } = buildPicks(dayRaces, preds);
    const p = period(date);
    const s = (stat[p] ??= { days: new Set(), all: [0, 0], hi: [0, 0] });
    s.days.add(date);
    for (const pick of barikataPicks) {
      const actual = cache.get(pick.raceId)!.actual;
      const hit = pick.combo === actual ? 1 : 0;
      s.all[0] += hit;
      s.all[1]++;
      if (pick.confidence != null && pick.confidence >= BARIKATA_HIGH_CONFIDENCE) {
        s.hi[0] += hit;
        s.hi[1]++;
      }
    }
  }
  for (const p of ["P1", "P2", "P3"]) {
    const s = stat[p];
    const pct = ([h, n]: [number, number]) => `${h}/${n} ${n ? ((h / n) * 100).toFixed(1) : "-"}%`;
    console.log(
      `${p}: 全体 ${pct(s.all)} ${(s.all[1] / s.days.size).toFixed(2)}件/日 | 確度高 ${pct(s.hi)} ${(s.hi[1] / s.days.size).toFixed(2)}件/日`
    );
  }
}
main();
