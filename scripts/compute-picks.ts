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
import { raceStage, generateNakaanaCandidate, orderBarikataSecondThird } from "../lib/scoring";
import {
  getRacesByDate,
  saveDailyPicks,
  saveBarikataPicks,
  saveBarikataNearMisses,
  saveNakaanaPicks,
  enableReadCache,
  DAILY_PICKS_MIN_MARGIN,
} from "../lib/repository";
import { todayJstStr, addDaysToDateStr } from "../lib/date";
import { closeDb } from "../lib/db";

/**
 * 「厳選」（daily_picks）「バリカタ」（barikata_picks/barikata_near_misses）
 * 「中穴候補」（nakaana_picks）をまとめて計算する。
 *
 * 元は scripts/daily-picks.ts と scripts/barikata-picks.ts の2本に分かれて
 * いたが、どちらも同じ日の同じレース群に対して独立に predictRace を呼んでおり
 * （1レースあたりDB約20回、選手単位のクエリはenableReadCache()でも重複排除
 * されない）、実質的に同じ計算を2回行っていた。データ更新の高速化調査
 * （2026-09）で「1日あたり約25-30秒の完全な無駄」と判明したため、1本の
 * predictions配列を計算し3種類のピック生成に使い回す形に統合した。
 * 各ピックの選定条件・検証根拠は元のコメントをそのまま引き継いでいる。
 */

/** 予選レースはscripts/diagnose-stage-holdout.tsで検証済みの理由（raceStage
 * のコメント参照）により、厳選の候補から除外する（daily_picksに保存しない＝
 * getDailyPicksの「上位10件」選定に混ざらない）。
 * 9人立てレースもscripts/diagnose-fieldsize.tsで検証済み（predictions実績、
 * 予選を除いた上でも◎単勝的中率が9人立て27.6-30.0%・それ以外44.4-44.9%と
 * 大きく低く、train/testホールドアウトでも再現）のため厳選・バリカタ・
 * 中穴候補すべてで同様に除外する。 */
const BARIKATA_MIN_MARGIN = 8;

/**
 * 厳選(daily_picks)候補から、「scoreMargin(margin)は10以上あるが、実際には
 * 本命(◎)と地力(racers.heikin_tokuten)が僅差の相手が別に存在する」レースを除外する
 * しきい値。scripts/diagnose-ability-gap-vs-margin.tsで検証済み（2026-09-18、
 * encp LIKE 'wt:%'・162日・predictRaceフルスキャンn=8,332件、うちmargin>=10母集団
 * n=581件）：marginはtotalScore差（ライン位置・脚質フィットのボーナスを含む）を
 * 見ているため、◎自身のライン内2番手のような「地位は近いがraw地力は離れている」
 * 選手をscored[1]（対抗）に押し上げてmarginを見かけ上大きくする一方、raw地力では
 * ◎に肉薄する別の1台（scored[1]とは限らない。実際54.2%のレースで別車だった）を
 * 見落としうる。この「abilityGap = ◎のheikin_tokuten - 非◎の中の最大heikin_tokuten」
 * が薄い(<5)母集団を脚質で層別したところ、最接近ライバルが逃/両（攻撃型、位置に
 * 依らず自ら動ける脚質）の時だけtrain/testとも一貫して回収率が悪化した
 * （n=317、全体回収率67.4%・train77.7%・test52.2%、いずれも100%割れ）。逆に
 * 追（追込型）の時はtrain/testともむしろ大幅黒字（n=151、全体170.3%・
 * train122.7%・test247.0%）で、fitScoreが既に前提とする
 * 「追込型は不利な位置(番手・単騎)では自ら動きにくい」という想定と整合する。
 * 実際のgetDailyPicks選定（margin>=10・day-by-day top10/日）を再現したシミュレーション
 * では、この条件（abilityGap<5×最接近ライバル逃/両）のレースを候補から除外すると
 * 1日平均ピック数は3.59件→1.63件に減るが、回収率は103.8%→145.2%（train98.9%→
 * 119.1%・test113.0%→210.0%、train/testとも改善方向で一致）と明確に向上した。
 * 除外されるレース自体の単体成績が回収率67.4%（train77.7%・test52.2%）と
 * train/testとも100%割れであることも確認済みで、単なる母数減らしではなく
 * 実際に不利なレースを取り除けている。
 */
const ABILITY_GAP_THIN_THRESHOLD = 5;

async function processDate(kaisaiDate: string): Promise<void> {
  const races = await getRacesByDate(kaisaiDate);
  console.log(`${kaisaiDate}: 対象レース${races.length}件`);
  if (races.length === 0) return;

  const predictions = await Promise.all(races.map((race) => predictRace(race.id)));

  // ---- 厳選（daily_picks） ----
  // 当日・翌日（ホーム画面の2タブ分）の全レース分のmarginをここでは絞らずに保存し、
  // 実際に「上位10件だけ表示する」という絞り込みはlib/repository.tsのgetDailyPicks
  // 側で行う（scripts/simulate-selective-strategy.tsの検証結果に基づく）。
  // ただしABILITY_GAP_THIN_THRESHOLDのコメントの通り、margin>=10でも◎とraw地力が
  // 僅差で逃/両タイプの最接近ライバルがいるレースはここで候補から除外する
  // （厳選＝dailyPicksだけの除外。バリカタ・中穴候補は未検証のため対象外）。
  const dailyPicks = races
    .map((race, i) => {
      if (raceStage(race.syumoku) === "予選") return null;
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 2) return null;
      if (prediction.scored.length === 9) return null;
      const honmei = prediction.scored[0];
      const taikou = prediction.scored[1];
      const honmeiScenario = prediction.scenarios.find((s) => s.label === "本命");
      if (!honmeiScenario) return null;
      const margin = honmei.totalScore - taikou.totalScore;

      // ABILITY_GAP_THIN_THRESHOLDのコメント参照：margin>=10（厳選候補）でも、
      // ◎とraw地力(heikin_tokuten)で肉薄する最接近ライバル（scored[1]とは限らない）が
      // 逃/両タイプの場合は除外する。heikin_tokutenが欠けている選手がいる場合は
      // 最接近ライバルを正しく特定できないため、この除外は適用しない（現状維持）。
      if (margin >= DAILY_PICKS_MIN_MARGIN) {
        const others = prediction.scored.slice(1);
        const hasAllTokuten =
          honmei.entry.heikin_tokuten != null && others.every((o) => o.entry.heikin_tokuten != null);
        if (hasAllTokuten) {
          let closest = others[0];
          for (const o of others) {
            if ((o.entry.heikin_tokuten as number) > (closest.entry.heikin_tokuten as number)) closest = o;
          }
          const abilityGap = (honmei.entry.heikin_tokuten as number) - (closest.entry.heikin_tokuten as number);
          const closestIsAttackType =
            closest.entry.kyakushitsu === "逃" || closest.entry.kyakushitsu === "両";
          if (abilityGap < ABILITY_GAP_THIN_THRESHOLD && closestIsAttackType) return null;
        }
      }

      return {
        raceId: race.id,
        kaisaiDate: race.kaisai_date,
        jocd: race.jocd,
        keirinjoName: race.keirinjo_name,
        raceNo: race.race_no,
        startTime: race.start_time,
        margin,
        honmeiCarNum: honmei.entry.car_num,
        honmeiName: honmei.entry.name,
        // その日実際に見せた買い目のスナップショット。後でスコアリングロジックを
        // 変更しても「前日の結果」表示が過去に遡って変わらないようにするため。
        formation: honmeiScenario.formation.combinations,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  // ---- バリカタ / バリカタ候補漏れ ----
  // 条件: margin(◎-対抗のスコア差)>=BARIKATA_MIN_MARGIN かつ
  // 予想1-2-3位（総合スコア順）が同じライングループ。この条件のレースは
  // 3連単フォーメーションではなく単一の並び（予想1-2-3位そのまま、1点=100円）の
  // 的中率が32.7%（margin単体条件の約2倍）、的中時平均オッズ4.13倍、
  // 1点買いの回収率は約140%だった（検証時点、n=197件）。この数値自体、
  // 診断スクリプト側で1日あたりの件数上限を設けずに集計したものなので、
  // 条件を満たすレースは何件あっても（0件でも）そのまま採用する。
  //
  // margin条件だけ満たすもの（sameLineの真偽を保持）を先にまとめ、後段でバリカタ本体と
  // 「候補漏れ」（同ラインでなかったもの）に振り分ける。diagnose-barikata-line.tsの
  // 検証で、候補漏れ側は同じmargin帯でも単一の並び的中率が大きく下がることが
  // 分かっているため（例: margin10-15で同ライン32.7%対別ライン混在9.5%）、
  // バリカタと同列には扱わず別テーブル（barikata_near_misses）に保存する。
  const marginCandidates = races
    .map((race, i) => {
      const prediction = predictions[i];
      if (!prediction || prediction.scored.length < 3) return null;
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

      // 2-3着はスコア順ではなく隊列順で決める（orderBarikataSecondThirdのコメント参照）。
      const [second, third] = orderBarikataSecondThird(scored[1], scored[2], sameLine);
      const combo = `${scored[0].entry.car_num}-${second.entry.car_num}-${third.entry.car_num}`;
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

  const barikataPicks = marginCandidates
    .filter((c) => c.sameLine)
    .map((c) => c.pick)
    .sort((a, b) => b.margin - a.margin);
  const barikataNearMisses = marginCandidates
    .filter((c) => !c.sameLine)
    .map((c) => c.pick)
    .sort((a, b) => b.margin - a.margin);

  // ---- 中穴候補（nakaana_picks） ----
  // margin8〜10・非同ライン向けの参考買い目。lib/scoring.tsのgenerateNakaanaCandidate
  // 参照（母数がまだ薄いため厳選・バリカタとは別枠の参考表示専用）。
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

  await saveDailyPicks(dailyPicks);
  await saveBarikataPicks(barikataPicks);
  await saveBarikataNearMisses(barikataNearMisses);
  await saveNakaanaPicks(nakaanaPicks);
  console.log(
    `  厳選: ${dailyPicks.length}件 / バリカタ: ${barikataPicks.length}件 / ` +
      `候補漏れ: ${barikataNearMisses.length}件 / 中穴候補: ${nakaanaPicks.length}件`
  );
}

async function main() {
  // 同じ選手・開催場の集計を全レースぶん引き直すのを防ぐ（Turso の読取行数削減）。
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
