/**
 * 「厳選」（daily_picks）「バリカタ」（barikata_picks/barikata_near_misses）
 * 「中穴候補」（nakaana_picks）の選定ロジック本体（DBアクセスなしの純粋関数）。
 * 元はscripts/compute-picks.tsのprocessDateに直書きされていたものをそのまま移した。
 * 変更前後で選定結果が同一であることを scripts/research/verify-fetch-optimization.ts
 * から同じ関数で確かめられるよう、エントリポイント（main()を即実行する）から分離している。
 */
import type { RacePrediction } from "../../lib/predict";
import { raceStage, generateNakaanaCandidate, orderBarikataSecondThird } from "../../lib/scoring";
import { DAILY_PICKS_MIN_MARGIN, DAILY_PICKS_MAX_MARGIN } from "../../lib/repository";
import type { RaceRow } from "../../lib/types";

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

export function buildPicks(races: RaceRow[], predictions: (RacePrediction | null)[]) {
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
      // margin16以上は全ての買い方で赤字（DAILY_PICKS_MAX_MARGINのコメント参照）
      if (margin >= DAILY_PICKS_MAX_MARGIN) return null;

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

      // 2-3着は2・3着モデル（lib/second-third-model.ts）の最上位ペア。1点のまま、
      // レース時点の情報だけの時系列検証で全期間的中数が増えた（P2 24→26・P3 33→36、
      // scripts/research/gensen-design-pit.ts）。モデルが無い場合は従来の隊列順補正。
      const top = prediction.secondThird?.[0];
      const [second, third] = orderBarikataSecondThird(scored[1], scored[2], sameLine);
      const combo = top
        ? `${scored[0].entry.car_num}-${top.second}-${top.third}`
        : `${scored[0].entry.car_num}-${second.entry.car_num}-${third.entry.car_num}`;
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

  return { dailyPicks, barikataPicks, barikataNearMisses, nakaanaPicks };
}

export type Picks = ReturnType<typeof buildPicks>;

/**
 * 発走時刻を過ぎたレースか（nowHHMMはJSTの"HH:MM"、races.start_timeと同じ書式）。
 * ピックは「発走前に実際に見せたもの」のスナップショットなので、発走後に
 * レース後の選手成績等で計算し直して上書きしてはいけない。start_timeが無い
 * レースは判断できないため従来どおり計算し直す側に倒す。
 */
export function hasRaceStarted(race: RaceRow, nowHHMM: string): boolean {
  return race.start_time != null && race.start_time <= nowHHMM;
}
