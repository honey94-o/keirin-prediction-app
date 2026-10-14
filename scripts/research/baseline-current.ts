/**
 * 2・3着研究のベースライン：現行ロジックそのままの厳選・バリカタ成績を
 * scored-cache.json（全確定レースを本番と同じpredictRaceで再計算したもの）上で再現する。
 */
import {
  loadCache,
  selectGensen,
  isBarikataCandidate,
  currentBarikataCombo,
  honmeiCombos,
  reportSplit,
  splitDate,
  evaluate,
  fmt,
} from "../lib/research-cache";

const all = loadCache();
const gensen = selectGensen(all);
const cut = splitDate(gensen);
console.log(`全確定レース ${all.length} / 厳選選定 ${gensen.length}件（${gensen[0].date}〜${gensen.at(-1)!.date}）`);

reportSplit("厳選・現行（本命シナリオの買い目）", gensen, honmeiCombos, cut);

const band = (lo: number, hi: number) => gensen.filter((r) => r.margin >= lo && r.margin < hi);
console.log("\nmargin帯別（全期間）");
for (const [lo, hi] of [
  [10, 13],
  [13, 16],
  [16, 99],
] as const) {
  console.log(`  ${lo}-${hi}: ${fmt(evaluate(band(lo, hi), honmeiCombos))}`);
}

// 軸的中・2-3着条件付き的中
const withOdds = gensen.filter((r) => r.hasOdds);
const axisHit = withOdds.filter((r) => r.actual.split("-")[0] === String(r.entries[0].car));
const fullGivenAxis = axisHit.filter((r) => honmeiCombos(r).includes(r.actual));
console.log(
  `\n◎1着率 ${((axisHit.length / withOdds.length) * 100).toFixed(1)}% (${axisHit.length}/${withOdds.length})` +
    ` / ◎1着時に2-3着まで的中 ${((fullGivenAxis.length / axisHit.length) * 100).toFixed(1)}%`
);

// 月別
console.log("\n月別（厳選・現行）");
const months = [...new Set(gensen.map((r) => r.date.slice(0, 6)))];
for (const m of months) console.log(`  ${m}: ${fmt(evaluate(gensen.filter((r) => r.date.startsWith(m)), honmeiCombos))}`);

const bari = all.filter(isBarikataCandidate);
reportSplit("バリカタ・現行（1点）", bari, (r) => [currentBarikataCombo(r)]);
