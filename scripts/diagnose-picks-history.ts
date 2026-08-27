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
 * 「厳選レース」の実際の日次スナップショット（daily_picks.formation、
 * predictRaceの再計算ではなく当日実際に表示した買い目そのもの）を使って、
 * 直近の回収率を集計する。ユーザー質問「直近の厳選レースの回収率」への回答用。
 * predict.tsの現在のロジックで遡って再評価するのではなく、実際に運用していた
 * 買い目ベースで見るのがこの機能の趣旨（lib/repository.tsのコメント参照）。
 */

const DAYS = Number(process.argv[2] ?? 30);

async function main() {
  const today = todayJstStr();
  const dates = Array.from({ length: DAYS }, (_, i) => addDaysToDateStr(today, -1 - i)).reverse();

  console.log(`日付 | 対象 | 的中 | 賭け金 | 払戻 | 日次回収率`);
  let totalStake = 0;
  let totalPayout = 0;
  let totalRaces = 0;
  let totalHits = 0;
  const dailyRoi: { date: string; roi: number | null; stake: number }[] = [];

  for (const date of dates) {
    const results = await getDailyPicksResults(date);
    const finished = results.filter((r) => r.finished);
    if (finished.length === 0) {
      dailyRoi.push({ date, roi: null, stake: 0 });
      continue;
    }
    const stake = finished.reduce((s, r) => s + (r.stakeYen ?? 0), 0);
    const payout = finished.reduce((s, r) => s + (r.payoutYen ?? 0), 0);
    const hits = finished.filter((r) => r.hit).length;
    const roi = stake > 0 ? (payout / stake) * 100 : null;
    console.log(
      `${date}: ${finished.length}レース ${hits}的中 ${stake}円 ${payout.toFixed(0)}円 ${roi?.toFixed(1)}%`
    );
    totalStake += stake;
    totalPayout += payout;
    totalRaces += finished.length;
    totalHits += hits;
    dailyRoi.push({ date, roi, stake });
  }

  console.log(`\n■ 集計期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${DAYS}日)`);
  console.log(`対象レース: ${totalRaces}件 / 的中: ${totalHits}件 (${((totalHits / totalRaces) * 100).toFixed(1)}%)`);
  console.log(`賭け金合計: ${totalStake}円 / 払戻合計: ${totalPayout.toFixed(0)}円`);
  console.log(`■ 全体回収率: ${((totalPayout / totalStake) * 100).toFixed(1)}%`);

  const activeDays = dailyRoi.filter((d) => d.roi != null);
  const above100 = activeDays.filter((d) => (d.roi ?? 0) >= 100).length;
  console.log(
    `\n日次回収率が100%以上だった日: ${above100}/${activeDays.length}日 (${((above100 / activeDays.length) * 100).toFixed(1)}%)`
  );

  // 直近7日・14日の内訳も見る（トレンドが変わっていないか）
  for (const window of [7, 14]) {
    const recent = dailyRoi.slice(-window).filter((d) => d.stake > 0);
    const stake = recent.reduce((s, d) => s + d.stake, 0);
    console.log(`直近${window}日: ${recent.length}日分データあり、賭け金${stake}円`);
  }
}

main();
