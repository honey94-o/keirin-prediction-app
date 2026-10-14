/**
 * 本番移植（lib/second-third-model.ts + lib/predict.ts）の動作確認。ローカルSQLiteに対して
 * 本番と同じpredictRaceを実行し、男子・◎1着レース（P3=2026-07-26以降）の2着的中率と
 * 2・3着ペア1点の的中率が研究結果（2着52.1%・ペア25.5%、旧並び50.6%・22.2%）と
 * 整合するか確かめる。係数は全期間で学習したものなのでやや楽観側に出てよい。
 */
import { useLocalDb } from "../lib/local-db";
import { predictRace } from "../../lib/predict";
import { loadCache } from "../lib/research-cache";

useLocalDb();

async function main() {
  const races = loadCache().filter(
    (r) => !r.girls && r.date >= "20260726" && !r.deadHeat && r.actual.split("-")[0] === String(r.entries[0].car)
  );
  let n = 0, model2 = 0, modelPair = 0, pool2 = 0, poolPair = 0;
  for (const r of races) {
    const p = await predictRace(r.raceId);
    if (!p?.secondThird?.length) continue;
    const [, s, t] = r.actual.split("-").map(Number);
    n++;
    const top = p.secondThird[0];
    const m2 = new Map<number, number>();
    for (const e of p.secondThird) m2.set(e.second, (m2.get(e.second) ?? 0) + e.p);
    const best2 = [...m2.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (best2 === s) model2++;
    if (top.second === s && top.third === t) modelPair++;
    if (r.honmeiPool[0] === s) pool2++;
    if (r.honmeiPool[0] === s && r.honmeiPool[1] === t) poolPair++;
  }
  const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;
  console.log(`男子◎1着 P3 n=${n}`);
  console.log(`  本番移植モデル: 2着 ${pct(model2)} / ペア1点 ${pct(modelPair)}`);
  console.log(`  旧並び       : 2着 ${pct(pool2)} / ペア1点 ${pct(poolPair)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
