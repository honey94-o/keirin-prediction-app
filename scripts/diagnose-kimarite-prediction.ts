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
import { getResultsForRace, enableReadCache } from "../lib/repository";

/**
 * ユーザー依頼「個々の個性を読み取って展開予想を書けないか」を受けて、前回の
 * generateRaceDevelopmentForecast（「誰が勝つか」の言い換えに過ぎず不採用・削除済み、
 * scripts/diagnose-development-forecast-validity.ts参照）とは根本的に違う切り口で
 * 検証する：「誰が勝つか」ではなく「実際の決まり手（逃げ/捲り/差し/マーク）」
 * そのものを予想できるかを見る。的中率だけでなく回収率に響く軸選びとは独立した
 * 価値がある（決まり手の読みが当たれば、シナリオ選択・展開予想の文章に使える）。
 *
 * 仮説：本命（総合1位）選手の個人の決まり手カウント（kimarite_nige_count等、
 * 自分が1-2着になった際の決まり手回数）から「この選手の得意な勝ち方」を求め、
 * それが実際のレースの決まり手（1着選手のresults.kimarite）と一致する率が、
 * バンク単体の決まり手傾向（venueKimariteRatesWithFallback、日付カットオフ済み）
 * より高いかを検証する。
 *
 * 注意：racers.kimarite_*_countは「現時点の最新カウント」で選手ごとに毎回
 * 上書きされ、レース単位の履歴を持たない（racersテーブルの属性バージョン管理が
 * 無い問題、過去に調査済みで恒久対応は見送り済み）。そのため過去レースの
 * バックテストとしてはやや楽観的な値になりうる点は留意する（ライブ予想では
 * この問題は発生しない）。
 */

const KIMARITE_LABELS = ["逃", "捲", "差", "マ"] as const;
type KimariteLabel = (typeof KIMARITE_LABELS)[number];

type Rec = {
  actualKimarite: KimariteLabel;
  honmeiPredictedKimarite: KimariteLabel | null; // 本命個人のカウントからの推定（十分な母数がある時のみ）
  venuePredictedKimarite: KimariteLabel; // バンク単体の最頻決まり手
  kaisaiDate: string;
};

async function main() {
  enableReadCache();
  const db = getDb();
  const raceIdsResult = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL
     ORDER BY r.race_id`
  );
  let raceIds = (raceIdsResult.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit) raceIds = raceIds.slice(-limit);
  console.log(`対象レース: ${raceIds.length}件${limit ? `（直近${limit}件に絞り込み）` : ""}`);

  // バンク単体の決まり手傾向は自前集計する（4種類そろえるため。venueKimariteは
  // マークを含まず逃/捲/差の3種のみなので、ここでは独自にjocd別の実測頻度を出す）。
  const kimariteByRaceResult = await db.execute(
    `SELECT ra.jocd, ra.kaisai_date, res.kimarite
     FROM results res
     JOIN races ra ON ra.id = res.race_id
     WHERE res.finish_pos = 1 AND res.kimarite IS NOT NULL
     ORDER BY ra.kaisai_date`
  );
  const kimariteRows = kimariteByRaceResult.rows as unknown as {
    jocd: string;
    kaisai_date: string;
    kimarite: string;
  }[];
  // jocd -> その日より前の決まり手カウント（日付カットオフ、venueKimarite等と同じ粒度）
  const venueHistory = new Map<string, Map<string, number>>();
  const venuePredictionByRaceKey = new Map<string, KimariteLabel>();
  {
    const byDate = new Map<string, typeof kimariteRows>();
    for (const r of kimariteRows) {
      if (!byDate.has(r.kaisai_date)) byDate.set(r.kaisai_date, []);
      byDate.get(r.kaisai_date)!.push(r);
    }
    for (const date of [...byDate.keys()].sort()) {
      for (const r of byDate.get(date)!) {
        const hist = venueHistory.get(r.jocd);
        if (hist && [...hist.values()].reduce((a, b) => a + b, 0) >= 20) {
          const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0] as KimariteLabel;
          venuePredictionByRaceKey.set(`${r.jocd}:${r.kaisai_date}`, top);
        }
      }
      for (const r of byDate.get(date)!) {
        if (!venueHistory.has(r.jocd)) venueHistory.set(r.jocd, new Map());
        const hist = venueHistory.get(r.jocd)!;
        hist.set(r.kimarite, (hist.get(r.kimarite) ?? 0) + 1);
      }
    }
  }

  const records: Rec[] = [];
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (raceId) => {
        const prediction = await predictRace(raceId);
        if (!prediction || prediction.scored.length < 2) return null;
        const { scored, race } = prediction;
        const honmei = scored[0];

        const raceResults = await getResultsForRace(raceId);
        const winnerResult = raceResults.find((r) => r.finish_pos === 1);
        if (!winnerResult?.kimarite || !KIMARITE_LABELS.includes(winnerResult.kimarite as KimariteLabel))
          return null;

        const venuePredicted = venuePredictionByRaceKey.get(`${race.jocd}:${race.kaisai_date}`);
        if (!venuePredicted) return null; // その場の母数がまだ20件に満たない

        const counts: Record<KimariteLabel, number> = {
          逃: honmei.entry.kimarite_nige_count ?? 0,
          捲: honmei.entry.kimarite_makuri_count ?? 0,
          差: honmei.entry.kimarite_sashi_count ?? 0,
          マ: honmei.entry.kimarite_mark_count ?? 0,
        };
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const honmeiPredicted =
          total >= 5
            ? (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as KimariteLabel)
            : null;

        const rec: Rec = {
          actualKimarite: winnerResult.kimarite as KimariteLabel,
          honmeiPredictedKimarite: honmeiPredicted,
          venuePredictedKimarite: venuePredicted,
          kaisaiDate: race.kaisai_date,
        };
        return rec;
      })
    );
    for (const r of results) if (r) records.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  処理済み: ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n判定対象: ${records.length}件\n`);

  const withHonmeiPred = records.filter((r) => r.honmeiPredictedKimarite != null);
  console.log(`本命の個人カウントが十分（>=5件）だったレース: ${withHonmeiPred.length}件\n`);

  function accuracy(data: Rec[], key: "honmeiPredictedKimarite" | "venuePredictedKimarite"): string {
    const valid = data.filter((r) => r[key] != null);
    const hits = valid.filter((r) => r[key] === r.actualKimarite).length;
    return valid.length > 0 ? `${((hits / valid.length) * 100).toFixed(1)}%(n=${valid.length})` : "-";
  }

  console.log("■ 全体正答率（実際の決まり手と一致した割合）");
  console.log(`  バンク単体（最頻決まり手を常に予想）: ${accuracy(withHonmeiPred, "venuePredictedKimarite")}`);
  console.log(`  本命個人のカウントから推定: ${accuracy(withHonmeiPred, "honmeiPredictedKimarite")}`);

  // バンク予想と本命予想が「食い違う」場合に、どちらが実際に近いか
  const diverged = withHonmeiPred.filter((r) => r.honmeiPredictedKimarite !== r.venuePredictedKimarite);
  console.log(`\n■ バンク予想と本命個人予想が食い違う場合（${diverged.length}件、本当に情報が増えているかの核心）`);
  console.log(`  バンク単体: ${accuracy(diverged, "venuePredictedKimarite")}`);
  console.log(`  本命個人: ${accuracy(diverged, "honmeiPredictedKimarite")}`);

  const dates = [...new Set(records.map((r) => r.kaisaiDate))].sort();
  const splitDate = dates[Math.floor(dates.length * (2 / 3))];
  const divergedTrain = diverged.filter((r) => r.kaisaiDate < splitDate);
  const divergedTest = diverged.filter((r) => r.kaisaiDate >= splitDate);
  console.log(`\ntrain=${dates[0]}〜、test=${splitDate}〜${dates[dates.length - 1]}`);
  console.log("--- train/testホールドアウト（食い違う場合） ---");
  console.log(`  [train] バンク${accuracy(divergedTrain, "venuePredictedKimarite")} / 本命個人${accuracy(divergedTrain, "honmeiPredictedKimarite")}`);
  console.log(`  [test]  バンク${accuracy(divergedTest, "venuePredictedKimarite")} / 本命個人${accuracy(divergedTest, "honmeiPredictedKimarite")}`);

  // 決まり手ごとの内訳（特定の決まり手だけ強いといった偏りがないか）
  console.log("\n■ 実際の決まり手の分布（参考）");
  for (const label of KIMARITE_LABELS) {
    const count = records.filter((r) => r.actualKimarite === label).length;
    console.log(`  ${label}: ${((count / records.length) * 100).toFixed(1)}% (${count}/${records.length})`);
  }
}

main();
