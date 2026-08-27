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

import { getDailyPicksResults } from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * ユーザー仮説「1着的中率は十分なので、2・3着の絞り込みを見直したい。
 * 現在の2点(中間帯margin)は広げてもいい。20点(高信頼度margin>=10)は
 * 絞るべきでは（回収率マイナスなのでは）」を、daily_picksの実際の
 * スナップショット（formation.length=その日実際に買った点数）で検証する。
 * predictRaceで再計算するのではなく、実際に表示・購入対象だった買い目
 * ベースで見る（lib/repository.tsのgetDailyPicksResultsと同じ思想）。
 */

const DAYS = Number(process.argv[2] ?? 60);

async function main() {
  const today = todayJstStr();
  const dates = Array.from({ length: DAYS }, (_, i) => addDaysToDateStr(today, -1 - i));

  const byPoints = new Map<number, { races: number; hits: number; stake: number; payout: number }>();

  let totalStake = 0;
  let totalPayout = 0;
  let totalRaces = 0;

  for (const date of dates) {
    const results = await getDailyPicksResults(date);
    for (const r of results) {
      if (!r.finished || r.pick.formation == null) continue;
      const points = r.pick.formation.length;
      const stat = byPoints.get(points) ?? { races: 0, hits: 0, stake: 0, payout: 0 };
      stat.races++;
      if (r.hit) stat.hits++;
      stat.stake += r.stakeYen ?? 0;
      stat.payout += r.payoutYen ?? 0;
      byPoints.set(points, stat);
      totalStake += r.stakeYen ?? 0;
      totalPayout += r.payoutYen ?? 0;
      totalRaces++;
    }
  }

  console.log(`集計期間: 直近${DAYS}日 (${dates[dates.length - 1]} 〜 ${dates[0]})`);
  console.log(`対象レース: ${totalRaces}件 / 全体回収率: ${((totalPayout / totalStake) * 100).toFixed(1)}%\n`);

  console.log("買い目点数 | レース数 | 的中率 | 賭け金 | 払戻 | 回収率");
  const sorted = [...byPoints.entries()].sort((a, b) => a[0] - b[0]);
  for (const [points, s] of sorted) {
    const hitRate = ((s.hits / s.races) * 100).toFixed(1);
    const roi = s.stake > 0 ? ((s.payout / s.stake) * 100).toFixed(1) : "-";
    console.log(
      `  ${points}点: ${s.races}件 的中率${hitRate}% (${s.hits}/${s.races}) 賭け金${s.stake}円 払戻${s.payout.toFixed(0)}円 回収率${roi}%`
    );
  }
}

main();
