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
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { predictRace } from "../lib/predict";
import {
  getRacesByDate,
  saveBarikataPicks,
  saveBarikataNearMisses,
  saveNakaanaPicks,
  enableReadCache,
} from "../lib/repository";
import { generateNakaanaCandidate } from "../lib/scoring";
import { todayJstStr, addDaysToDateStr } from "../lib/date";
import { closeDb } from "../lib/db";

/**
 * 「バリカタ」レース（scripts/diagnose-barikata.ts・-line.tsで検証済み）を
 * 全件選び、barikata_picksに保存する。ホーム画面「本日のバリカタ」用。
 * 同じpredictions配列から「バリカタ候補漏れ」と「中穴候補」
 * （lib/scoring.tsのgenerateNakaanaCandidate参照）も計算する
 * （predictRaceの再実行を避けるため専用スクリプトに分けていない）。
 *
 * 条件: margin(◎-対抗のスコア差)>=BARIKATA_MIN_MARGIN かつ
 * 予想1-2-3位（総合スコア順）が同じライングループ。この条件のレースは
 * 3連単フォーメーションではなく単一の並び（予想1-2-3位そのまま、1点=100円）の
 * 的中率が32.7%（margin単体条件の約2倍）、的中時平均オッズ4.13倍、
 * 1点買いの回収率は約140%だった（検証時点、n=197件）。この数値自体、
 * 診断スクリプト側で1日あたりの件数上限を設けずに集計したものなので、
 * 条件を満たすレースは何件あっても（0件でも）そのまま採用する
 * （以前は表示都合で1日3件に絞っていたが、検証結果とは無関係な制約だった）。
 */
const BARIKATA_MIN_MARGIN = 8;

async function processDate(kaisaiDate: string): Promise<void> {
  const races = await getRacesByDate(kaisaiDate);
  console.log(`${kaisaiDate}: 対象レース${races.length}件`);
  if (races.length === 0) return;

  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));

  // margin条件だけ満たすもの（sameLineの真偽を保持）を先にまとめ、後段でバリカタ本体と
  // 「候補漏れ」（同ラインでなかったもの）に振り分ける。diagnose-barikata-line.tsの
  // 検証で、候補漏れ側は同じmargin帯でも単一の並び的中率が大きく下がることが
  // 分かっているため（例: margin10-15で同ライン32.7%対別ライン混在9.5%）、
  // バリカタと同列には扱わず別テーブル（barikata_near_misses）に保存する
  // ——「marginは強いのになぜバリカタに入らないか」を確認できるようにするため。
  const marginCandidates = races
    .map((race, i) => {
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 3) return null;
      // 9人立ては◎的中率が有意に低い（scripts/diagnose-fieldsize.ts、holdout検証済み）。
      // 単一の並びを1点買いするバリカタは的中率の影響がより直接効くため同様に除外する。
      if (prediction.scored.length === 9) return null;
      const { scored } = prediction;
      const honmei = scored[0];
      const taikou = scored[1];
      const margin = honmei.totalScore - taikou.totalScore;
      if (margin < BARIKATA_MIN_MARGIN) return null;

      const lg0 = scored[0].entry.line_group;
      const lg1 = scored[1].entry.line_group;
      const lg2 = scored[2].entry.line_group;
      const sameLine = lg0 != null && lg0 === lg1 && lg1 === lg2;

      const combo = `${scored[0].entry.car_num}-${scored[1].entry.car_num}-${scored[2].entry.car_num}`;
      return {
        sameLine,
        pick: {
          raceId: race.id,
          kaisaiDate: race.kaisai_date,
          jocd: race.jocd,
          keirinjoName: race.keirinjo_name,
          raceNo: race.race_no,
          startTime: race.start_time,
          margin,
          combo,
          honmeiCarNum: honmei.entry.car_num,
          honmeiName: honmei.entry.name,
        },
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);

  const picks = marginCandidates
    .filter((c) => c.sameLine)
    .map((c) => c.pick)
    .sort((a, b) => b.margin - a.margin);
  const nearMisses = marginCandidates
    .filter((c) => !c.sameLine)
    .map((c) => c.pick)
    .sort((a, b) => b.margin - a.margin);

  // 「中穴候補」（lib/scoring.tsのgenerateNakaanaCandidate、margin8〜10・非同ライン
  // 向けの参考買い目）も同じpredictions配列から計算する。predictRaceの再実行を
  // 避けるため、専用スクリプトを分けずここに統合している。
  const nakaanaPicks = races
    .map((race, i) => {
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 3 || prediction.scored.length === 9) return null;
      const candidate = generateNakaanaCandidate(prediction.scored);
      if (!candidate) return null;
      const margin = prediction.scored[0].totalScore - prediction.scored[1].totalScore;
      return {
        raceId: race.id,
        kaisaiDate: race.kaisai_date,
        jocd: race.jocd,
        keirinjoName: race.keirinjo_name,
        raceNo: race.race_no,
        startTime: race.start_time,
        margin,
        honmeiCarNum: candidate.axisCarNum,
        honmeiName: candidate.axisName,
        taikouCarNum: candidate.taikouCarNum,
        taikouName: candidate.taikouName,
        formation: candidate.combinations,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null)
    .sort((a, b) => b.margin - a.margin);

  await saveBarikataPicks(picks);
  await saveBarikataNearMisses(nearMisses);
  await saveNakaanaPicks(nakaanaPicks);
  console.log(
    `  margin条件を満たすレース: ${marginCandidates.length}件 → バリカタ: ${picks.length}件 / 候補漏れ: ${nearMisses.length}件 / 中穴候補: ${nakaanaPicks.length}件`
  );
}

async function main() {
  enableReadCache();

  const today = todayJstStr();
  const tomorrow = addDaysToDateStr(today, 1);
  const start = Date.now();
  await processDate(today);
  await processDate(tomorrow);
  console.log(`完了 (${Date.now() - start}ms)`);
  // pg.PoolはデフォルトでidleTimeoutMillis=10000msのため、明示的にend()しないと
  // 計算後もアイドルタイムアウトまでプロセスが終了できない（lib/db.tsのcloseDb参照）。
  await closeDb();
}

main();
