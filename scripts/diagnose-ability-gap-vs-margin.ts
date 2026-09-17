import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

/**
 * 【検証結果: 採用（scripts/compute-picks.tsに選定レベルの除外フィルタを実装済み、
 * lib/repository.tsのDAILY_PICKS_MIN_MARGINをexport化。ともに未コミット）】
 *
 * ■ 背景・問い
 * 2026-09-17の厳選(daily_picks, margin>=10)手動レビューで7件中2的中5大外れ、
 * うち3件で同一パターンが再現した：本命(scored[0], totalScore最高)の
 * raw地力(racers.heikin_tokuten)に肉薄する対抗馬が、必ずしも◎対抗
 * (scored[1], totalScore2位)ではない別の1台として存在し、その選手が
 * 実際に勝ってしまった（武雄5R race_id=28311・立川4R race_id=28389・
 * 防府6R race_id=28350、いずれも最接近ライバルの脚質は逃/両）。marginは
 * totalScore差（calculateLineScore/calculateKyakushitsuScoreのライン位置・
 * 脚質フィットボーナスを含む）を見ているため、ライン内の2番手のような
 * 「地位は近いがraw地力は離れている」選手をscored[1]に押し上げてmarginを
 * 見かけ上大きくする一方、raw地力では肉薄する別の1台（番手・単騎等の
 * 「不利な位置」）を見落としうる、という仮説を検証する。
 *
 * ■ 方法
 * scripts/compute-picks.tsのdailyPicks構築と完全に同一の除外基準
 * （raceStage()==='予選'除外、9人立て(scored.length===9)除外、「本命」
 * シナリオ必須）でpredictRaceを直接フルスキャンした（predictionsテーブルの
 * スナップショットは日付ごとにロジックのバージョンが混在しており
 * scripts/diagnose-gensen-realized-vs-backtest.tsで使用不可と判明済みのため、
 * 同スクリプトと同じ方式でpredictRaceを実レースIDに対して再実行し常に
 * 現行コードで予想を作り直した）。対象はencp LIKE 'wt:%'・結果確定済み全レース
 * 12,223件（BATCH=25並列、実測約42分）。
 *
 * scoreMargin = scored[0].totalScore - scored[1].totalScore（既存のmarginと同一）。
 * abilityGap = scored[0].entry.heikin_tokuten - max(heikin_tokuten of scored.slice(1))
 * 　　　　　　（scored[1]とは限らない、非軸の中でraw地力が最も近い1台との差）。
 * 対象レース全員（軸含む）のheikin_tokutenが揃っていないレースは除外する
 * （欠損選手が実は最接近ライバルだった場合にabilityGapを過大評価してしまうため。
 * 実測では該当0件）。的中判定・オッズ解決はresolveActualCombo（lib/repository.ts、
 * backtest.ts等と同じ）。train/testは開催日で2/3・1/3にクロノロジカル分割
 * （このプロジェクトの標準、分割日20260726）。
 *
 * フルスキャン中、Neon（サーバーレスPostgres）側の一時的なリソース枯渇
 * （out of memory、lib/db.tsのwithRetryが拾わないエラークラス）で1回失敗した
 * （8025/12221件処理時点、encp LIKE 'wt:%'の別の実行と同時にDBへ負荷をかけて
 * いたことが原因と推測）。レース単位でのリトライ（最大3回）を追加した上で
 * 独立に2回再実行し、両方とも成功・数値もほぼ完全に一致（n=8330/8332、
 * 誤差は実行間隔でDBに新規到着した数レース分）したことを確認済み。
 * 以下は最終確定した1回（n=8332、DBエラー除外0）の数値。
 *
 * ■ サンプルサイズ
 * 対象race 12,223件 → 候補8,332件（予選除外3,295 / 9人立て除外595 /
 * 本命formation無し除外0 / 対抗無し除外0 / heikin_tokuten欠損除外0 /
 * 結果未確定除外1 / DBエラー除外0）。162日（20260409〜20260917）、
 * train/test分割日20260726。scoreMargin>=10（実際のgetDailyPicks選定対象）
 * はn=581件（1日平均3.59件、このプロジェクトの目安=診断あたり最低30件を
 * 大きく超える規模）。
 *
 * ■ Step1: abilityGap分布・乖離率（「最接近ライバル」がscored[1]と別車の割合）
 *   全候補(n=8332)中: 5,079件(61.0%)で最接近ライバルがscored[1]と別車。
 *   scoreMargin>=10母集団(n=581)でも: 315件(54.2%)で別車。
 *   → 「marginが見ているscored[1]」と「raw地力で本当に肉薄する相手」が
 *   一致しないケースはむしろ多数派で、稀な現象ではない。仮説の前提
 *   （marginが本当のライバルを見落としうる）には十分な母数の余地がある。
 *   abilityGap分布(全候補): median=-0.53（totalScore首位=◎が、raw地力では
 *   フィールド最高位ですらないケースが半数超を占める＝ライン/脚質ボーナスの
 *   影響が非常に大きいことを示す副産物）。scoreMargin>=10母集団ではmedian=3.12
 *   （高marginでもp10=-2.11と、稀に◎よりraw地力が高い相手が残っている）。
 *
 * ■ Step2: scoreMargin>=10母集団(n=581)をabilityGap単体で層別 → 不安定・不採用材料
 *   abilityGap<3(激薄) : n=279 回収率112.4%(train84.8%/test153.2%)
 *   abilityGap3-5      : n=189 回収率85.0% (train107.0%/test49.8%)
 *   abilityGap<5(合算) : n=468 回収率102.2%(train93.2%/test115.8%)
 *   abilityGap>=5(合意): n=113 回収率110.3%(train115.4%/test82.8%)
 *   → abilityGap単体では「薄い方が悪い」という単調な傾向は無く、<3帯はtrain
 *   悪化・test改善、3-5帯はtrain改善・test悪化と、隣接する帯同士でtrain/testの
 *   方向がねじれる。<5(合算) vs >=5(合意)の主比較も、全体では>=5がやや高い
 *   (110.3%>102.2%)が、train(115.4%>93.2%)とtest(82.8%<115.8%)で優劣が逆転する。
 *   このプロジェクトの基準（train/test同方向）に照らし、abilityGap単体は
 *   不安定でこのままでは採用できないと判断した。
 *
 * ■ Step3【決定的】: abilityGap<5(薄い)母集団を、最接近ライバルの脚質で層別
 *   逃/両(攻撃型): n=317 回収率67.4%(train77.7%/test52.2%) → train/testとも100%割れ
 *   追(追込型)  : n=151 回収率170.3%(train122.7%/test247.0%) → train/testとも大幅黒字
 *   （脚質不明は0件、heikin_tokuten完備母集団では欠損なし）
 *   abilityGap<3(激薄)に絞るとさらに極端: 逃/両62.9%(train70.1%/test52.1%) vs
 *   追183.4%(train105.8%/test299.0%)。
 *   → Step2の「abilityGap単体では不安定」という結果が一変し、最接近ライバルの
 *   脚質で層別すると2つの層が正反対方向にtrain/testとも一貫する、非常にクリーンな
 *   分岐が現れた。ユーザーの手動レビュー3件（いずれも最接近ライバルが逃/両）が
 *   示唆した「攻撃型（逃/両）の肉薄ライバルは位置に依らず脅威になる、追込型は
 *   不利な位置では脅威になりにくい」というメカニズム仮説と方向が完全に一致する。
 *   参考: 乖離(divergent、最接近ライバル≠scored[1])単体では方向が定まらない
 *   （乖離あり・薄いn=243は回収率123.6%、乖離なし・薄いn=225は76.4%）ため、
 *   「乖離」自体はリスク要因ではなく、あくまで脚質が本質的なドライバーだった。
 *
 * ■ Step4: 厳選(daily_picks) day-by-day選定シミュレーション（margin>=10・上位10件/日、
 *   getDailyPicks再現、compute-picks.tsのdailyPicks構築と同じ除外基準）
 *   baseline（現行）: n=581 1日平均3.59件 回収率103.8%(train98.9%/test113.0%)
 *   候補A（abilityGap<5×逃/両を除外）: n=264 1日平均1.63件
 *     回収率145.2%(train119.1%/test210.0%) ← train/testとも改善、方向一致
 *   候補B（abilityGap<3×逃/両を除外、より絞った条件）: n=415 1日平均2.56件
 *     回収率121.1%(train109.6%/test144.9%) ← こちらもtrain/testとも改善だが
 *     候補Aより改善幅が小さい
 *   除外される候補A分（n=317）単体の成績は回収率67.4%(train77.7%/test52.2%)と
 *   train/testとも100%割れで、「除外は単なる母数減らしではなく実際に不利な
 *   レースを取り除けている」ことを確認した（scripts/diagnose-gensen-margin-
 *   threshold.tsが警告する「top10は稀にしか効かないため除外の効果を必ず
 *   除外分単体で確認する」という教訓を踏襲）。1日平均ピック数は3.59→1.63件と
 *   半分以下に減るが、回収率の改善幅（+41.4pt、train/testとも黒字転換/深化）が
 *   大きく、「厳選という月100k円目標に効く規模の改善」と判断できる。
 *
 * ■ 結論: 採用
 * abilityGap単体（Step2）は不安定で不採用材料だったが、「最接近ライバルの脚質」
 * を組み合わせたStep3で真に安定した信号が見つかり、Step4の実運用同等シミュレーション
 * （getDailyPicks再現、除外分単体の検証込み）でも一貫して改善したため、
 * scripts/compute-picks.tsのdailyPicks構築に選定レベルの除外フィルタ
 * （ABILITY_GAP_THIN_THRESHOLD=5、margin>=10かつabilityGap<5かつ最接近ライバル
 * 脚質が逃/両のレースを候補から除外）を実装した（lib/repository.tsの
 * DAILY_PICKS_MIN_MARGINは元々export無しでcompute-picks.tsから参照できなかった
 * ため、値はそのまま変更せずexportのみ追加）。heikin_tokuten欠損時は判定不能
 * として除外フィルタを適用せず現状維持する。バリカタ・中穴候補は今回検証して
 * いないため対象外（両者ともdailyPicksとは別の候補生成ロジック）。
 * 残る留保点: (1) train/test分割は1本のみ（分割日を変えたクロスチェックは
 * 未実施）、(2) 除外分の的中時払戻が高いケース（逃/両で稀に決まった場合の
 * オッズ）が回収率の振れ幅を大きくしている可能性があり、n=317でもなお
 * 数件の高配当的中/機会損失に数字が引っ張られている余地はある、(3) 他の
 * 既知の要因（分戦数・ガールズ等）との交互作用は個別に統制していない。
 * 実装後は他の厳選関連の変更と同様、daily_picksの実績推移を継続的に監視する。
 */

import { getDb, closeDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { raceStage } from "../lib/scoring";
import {
  getResultsForRace,
  getOddsForRace,
  resolveActualCombo,
  enableReadCache,
  DAILY_PICKS_MIN_MARGIN,
} from "../lib/repository";

type Candidate = {
  raceId: number;
  date: string;
  scoreMargin: number;
  abilityGap: number;
  divergent: boolean; // 「最接近ライバル(raw地力)」が scored[1](ナイーブな対抗) と別車かどうか
  closestKyakushitsu: string | null; // 最接近ライバルの脚質
  formation: string[];
  actualCombo: string | null;
  hitOdds: number | null;
};

type SelResult = { hits: number; races: number; stake: number; payout: number };

function evalOutcomes(arr: Candidate[]): SelResult {
  let hits = 0,
    races = 0,
    stake = 0,
    payout = 0;
  for (const c of arr) {
    if (c.actualCombo == null) continue;
    races++;
    stake += 100 * c.formation.length;
    if (c.formation.includes(c.actualCombo)) {
      hits++;
      if (c.hitOdds != null) payout += 100 * c.hitOdds;
    }
  }
  return { hits, races, stake, payout };
}

function fmtSel(s: SelResult): string {
  const hr = s.races > 0 ? ((100 * s.hits) / s.races).toFixed(1) + "%" : "-";
  const roi = s.stake > 0 ? ((100 * s.payout) / s.stake).toFixed(1) + "%" : "-";
  const pnl = s.payout - s.stake;
  return `的中${hr}(${s.hits}/${s.races}) 回収率${roi} 損益${Math.round(pnl)}円`;
}

// フルスキャンは1回45分規模でNeonのDB負荷も小さくない（実際に1回OOMで失敗した）ため、
// Step4（day-by-day選定シミュレーション）の閾値を試行錯誤する段階では再スキャンせず、
// 直前のスキャン結果（candidates配列）をJSONにキャッシュして使い回せるようにする。
// --from-cache=<path> でキャッシュから読み込み、DBスキャンを完全にスキップする。
const CACHE_ARG_PREFIX = "--from-cache=";

async function main() {
  const fromCacheArg = process.argv.find((a) => a.startsWith(CACHE_ARG_PREFIX));
  let candidates: Candidate[];

  if (fromCacheArg) {
    const cachePath = fromCacheArg.slice(CACHE_ARG_PREFIX.length);
    console.log(`キャッシュから読込: ${cachePath}`);
    candidates = JSON.parse(readFileSync(cachePath, "utf-8")) as Candidate[];
    console.log(`候補読込完了: ${candidates.length}件`);
  } else {
    candidates = await scanAllRaces();
    const cacheOutArg = process.argv.find((a) => a.startsWith("--cache-out="));
    const cacheOutPath = cacheOutArg
      ? cacheOutArg.slice("--cache-out=".length)
      : path.join(process.cwd(), "scripts", "data", "ability-gap-candidates-cache.json");
    writeFileSync(cacheOutPath, JSON.stringify(candidates));
    console.log(`候補データをキャッシュ保存: ${cacheOutPath}`);
  }

  runAnalysis(candidates);
  await closeDb();
}

async function scanAllRaces(): Promise<Candidate[]> {
  enableReadCache();
  const db = getDb();
  const res = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL AND ra.encp LIKE 'wt:%' ORDER BY r.race_id`
  );
  let ids = (res.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limArg = process.argv.find((a) => a.startsWith("--limit="));
  if (limArg) ids = ids.slice(-Number(limArg.split("=")[1]));
  console.log(`対象race: ${ids.length}件`);

  const candidates: Candidate[] = [];
  let excludedNoTaikou = 0,
    excludedYosen = 0,
    excluded9car = 0,
    excludedNoFormation = 0,
    excludedMissingTokuten = 0,
    excludedNoResult = 0,
    excludedError = 0;

  // Neon（サーバーレスPostgres）は高並列時にまれに一時的なリソース枯渇
  // （out of memory等、lib/db.tsのwithRetryが拾わないエラークラス）を返すことが
  // 実測で確認された（8025/12221件処理時点で発生）。40分規模のフルスキャンが
  // 1レースの一時的なDBエラーで丸ごと失敗するのを避けるため、レース単位で
  // 数回リトライしてから諦める（諦めた分はexcludedErrorとして記録し分析からは除外）。
  async function predictRaceWithRetry(raceId: number, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await predictRace(raceId);
      } catch (err) {
        if (attempt === attempts) {
          console.warn(`  race ${raceId}: predictRace失敗（${attempts}回リトライ後も失敗）: ${err}`);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    return undefined;
  }

  const BATCH = 25;
  const startTime = Date.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const out = await Promise.all(
      chunk.map(async (raceId): Promise<Candidate | null> => {
        const p = await predictRaceWithRetry(raceId);
        if (p === undefined) {
          excludedError++;
          return null;
        }
        if (!p || p.scored.length < 2) {
          excludedNoTaikou++;
          return null;
        }
        if (raceStage(p.race.syumoku) === "予選") {
          excludedYosen++;
          return null;
        }
        if (p.scored.length === 9) {
          excluded9car++;
          return null;
        }
        const honmeiScenario = p.scenarios.find((s) => s.label === "本命");
        if (!honmeiScenario) {
          excludedNoFormation++;
          return null;
        }

        const axis = p.scored[0];
        const taikou = p.scored[1];
        const others = p.scored.slice(1);
        if (axis.entry.heikin_tokuten == null || others.some((o) => o.entry.heikin_tokuten == null)) {
          excludedMissingTokuten++;
          return null;
        }
        let closest = others[0];
        for (const o of others) {
          if ((o.entry.heikin_tokuten as number) > (closest.entry.heikin_tokuten as number)) closest = o;
        }
        const abilityGap = (axis.entry.heikin_tokuten as number) - (closest.entry.heikin_tokuten as number);
        const divergent = closest.entry.car_num !== taikou.entry.car_num;
        const scoreMargin = axis.totalScore - taikou.totalScore;

        let results, odds;
        try {
          [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
        } catch (err) {
          console.warn(`  race ${raceId}: results/odds取得失敗: ${err}`);
          excludedError++;
          return null;
        }
        const actualCombo = resolveActualCombo(results, odds);
        if (actualCombo == null) {
          excludedNoResult++;
          return null;
        }
        const hitOdds =
          odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;

        return {
          raceId,
          date: p.race.kaisai_date,
          scoreMargin,
          abilityGap,
          divergent,
          closestKyakushitsu: closest.entry.kyakushitsu,
          formation: honmeiScenario.formation.combinations,
          actualCombo,
          hitOdds,
        };
      })
    );
    for (const c of out) if (c) candidates.push(c);
    if ((i / BATCH) % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  進捗 ${Math.min(i + BATCH, ids.length)}/${ids.length} (${elapsed}s経過)`);
    }
  }

  console.log(
    `\n候補生成完了: ${candidates.length}件（予選除外${excludedYosen} / 9人立て除外${excluded9car} / ` +
      `本命formation無し除外${excludedNoFormation} / 対抗無し除外${excludedNoTaikou} / ` +
      `heikin_tokuten欠損除外${excludedMissingTokuten} / 結果未確定除外${excludedNoResult} / ` +
      `DBエラー除外${excludedError}）`
  );

  return candidates;
}

function runAnalysis(candidates: Candidate[]): void {
  const dates = [...new Set(candidates.map((c) => c.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(
    `対象日数: ${dates.length}日（${dates[0]}〜${dates.at(-1)}） train/test分割日: ${split}`
  );

  function bandStats(arr: Candidate[]): string {
    const train = arr.filter((c) => c.date < split);
    const test = arr.filter((c) => c.date >= split);
    return `${fmtSel(evalOutcomes(arr))} (train${fmtSel(evalOutcomes(train))} / test${fmtSel(evalOutcomes(test))})`;
  }

  // ========== Step1: 乖離率（最接近ライバル ≠ ナイーブな対抗scored[1]）==========
  console.log("\n========== Step1: abilityGap分布 と 乖離率 ==========");
  const divergentAll = candidates.filter((c) => c.divergent).length;
  console.log(
    `全候補(${candidates.length}件)中、最接近ライバルがscored[1]と別車: ${divergentAll}件 ` +
      `(${((100 * divergentAll) / candidates.length).toFixed(1)}%)`
  );

  const margin10Pop = candidates.filter((c) => c.scoreMargin >= DAILY_PICKS_MIN_MARGIN);
  const divergentM10 = margin10Pop.filter((c) => c.divergent).length;
  console.log(
    `scoreMargin>=${DAILY_PICKS_MIN_MARGIN}の母集団(${margin10Pop.length}件)中、乖離: ${divergentM10}件 ` +
      `(${margin10Pop.length > 0 ? ((100 * divergentM10) / margin10Pop.length).toFixed(1) : "-"}%)`
  );

  const gaps = [...candidates.map((c) => c.abilityGap)].sort((a, b) => a - b);
  const pct = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(2);
  console.log(
    `abilityGap分布(全候補): min=${gaps[0]?.toFixed(2)} p10=${pct(0.1)} p25=${pct(0.25)} ` +
      `median=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} max=${gaps.at(-1)?.toFixed(2)}`
  );
  const gapsM10 = [...margin10Pop.map((c) => c.abilityGap)].sort((a, b) => a - b);
  const pctM10 = (p: number) => gapsM10[Math.min(gapsM10.length - 1, Math.floor(gapsM10.length * p))].toFixed(2);
  if (gapsM10.length > 0) {
    console.log(
      `abilityGap分布(scoreMargin>=10母集団): min=${gapsM10[0].toFixed(2)} p10=${pctM10(0.1)} ` +
        `p25=${pctM10(0.25)} median=${pctM10(0.5)} p75=${pctM10(0.75)} p90=${pctM10(0.9)} max=${gapsM10.at(-1)!.toFixed(2)}`
    );
  }

  // ========== Step2: scoreMargin>=10母集団を abilityGap で層別 ==========
  console.log(
    `\n========== Step2: scoreMargin>=${DAILY_PICKS_MIN_MARGIN}母集団(n=${margin10Pop.length})を abilityGapで層別 ==========`
  );
  const bandDefs: [string, (c: Candidate) => boolean][] = [
    ["abilityGap<3 (激薄)", (c) => c.abilityGap < 3],
    ["abilityGap 3-5", (c) => c.abilityGap >= 3 && c.abilityGap < 5],
    ["abilityGap<5 (薄い合算)", (c) => c.abilityGap < 5],
    ["abilityGap>=5 (合意)", (c) => c.abilityGap >= 5],
  ];
  for (const [label, pred] of bandDefs) {
    const subset = margin10Pop.filter(pred);
    console.log(`  ${label}: n=${subset.length} ${bandStats(subset)}`);
  }

  // ========== Step3: abilityGapが薄い母集団を、最接近ライバルの脚質で層別 ==========
  console.log("\n========== Step3: abilityGap<5(薄い)母集団を、最接近ライバルの脚質で層別 ==========");
  const thin = margin10Pop.filter((c) => c.abilityGap < 5);
  const attackType = thin.filter((c) => c.closestKyakushitsu === "逃" || c.closestKyakushitsu === "両");
  const chaseType = thin.filter((c) => c.closestKyakushitsu === "追");
  const nullType = thin.filter((c) => c.closestKyakushitsu == null);
  console.log(`  逃/両(攻撃型): n=${attackType.length} ${bandStats(attackType)}`);
  console.log(`  追(追込型)  : n=${chaseType.length} ${bandStats(chaseType)}`);
  console.log(`  脚質不明    : n=${nullType.length} ${bandStats(nullType)}`);

  console.log("\n--- 参考: abilityGap<3(激薄)母集団での同じ層別 ---");
  const thin3 = margin10Pop.filter((c) => c.abilityGap < 3);
  const attackType3 = thin3.filter((c) => c.closestKyakushitsu === "逃" || c.closestKyakushitsu === "両");
  const chaseType3 = thin3.filter((c) => c.closestKyakushitsu === "追");
  console.log(`  逃/両(攻撃型): n=${attackType3.length} ${bandStats(attackType3)}`);
  console.log(`  追(追込型)  : n=${chaseType3.length} ${bandStats(chaseType3)}`);

  // ========== 参考: 手動レビューが指摘した「乖離あり×abilityGap薄い」の複合条件 ==========
  console.log("\n========== 参考: 乖離(divergent) × abilityGap<5 の複合条件 ==========");
  const divergentThin = margin10Pop.filter((c) => c.divergent && c.abilityGap < 5);
  const nonDivergentThin = margin10Pop.filter((c) => !c.divergent && c.abilityGap < 5);
  console.log(`  乖離あり・薄い: n=${divergentThin.length} ${bandStats(divergentThin)}`);
  console.log(`  乖離なし・薄い(=scored[1]自体が僅差): n=${nonDivergentThin.length} ${bandStats(nonDivergentThin)}`);

  // ========== Step4: 「厳選(daily_picks)」day-by-day選定シミュレーション ==========
  // Step3で「abilityGap薄い×最接近ライバル逃/両」が train/test とも一貫して回収率を
  // 悪化させる（逆に追型は一貫して大幅黒字）という実運用に効きうる信号が見えたため、
  // 実際のgetDailyPicks選定（margin>=10・日別上位10件）からこの条件のレースだけを
  // 除外した場合に、1日あたりのピック数と的中率/回収率がどう変わるかを検証する。
  console.log(
    "\n========== Step4: 厳選(daily_picks) day-by-day選定シミュレーション（除外案の検証） =========="
  );

  type PickSelResult = SelResult & { days: number; picks: number };
  function simulateTop10PerDay(
    eligibleFn: (c: Candidate) => boolean,
    dateFilter: (d: string) => boolean
  ): PickSelResult {
    const byDate = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!dateFilter(c.date)) continue;
      const arr = byDate.get(c.date) ?? [];
      arr.push(c);
      byDate.set(c.date, arr);
    }
    let hits = 0,
      races = 0,
      stake = 0,
      payout = 0,
      picks = 0,
      days = 0;
    for (const [, arr] of byDate) {
      days++;
      const top10 = arr
        .filter((c) => c.scoreMargin >= DAILY_PICKS_MIN_MARGIN && eligibleFn(c))
        .sort((a, b) => b.scoreMargin - a.scoreMargin)
        .slice(0, 10);
      picks += top10.length;
      for (const c of top10) {
        if (c.actualCombo == null) continue;
        races++;
        stake += 100 * c.formation.length;
        if (c.formation.includes(c.actualCombo)) {
          hits++;
          if (c.hitOdds != null) payout += 100 * c.hitOdds;
        }
      }
    }
    return { hits, races, stake, payout, days, picks };
  }
  function fmtPick(s: PickSelResult): string {
    return `1日平均${(s.picks / s.days).toFixed(2)}件(${s.picks}件/${s.days}日) ${fmtSel(s)}`;
  }

  const isAllD = () => true;
  const isTrainD = (d: string) => d < split;
  const isTestD = (d: string) => d >= split;

  function reportRule(label: string, eligibleFn: (c: Candidate) => boolean): void {
    console.log(`\n--- ${label} ---`);
    console.log(`  全体  ${fmtPick(simulateTop10PerDay(eligibleFn, isAllD))}`);
    console.log(`  train ${fmtPick(simulateTop10PerDay(eligibleFn, isTrainD))}`);
    console.log(`  test  ${fmtPick(simulateTop10PerDay(eligibleFn, isTestD))}`);
  }

  const isBadRival = (c: Candidate) =>
    c.closestKyakushitsu === "逃" || c.closestKyakushitsu === "両";

  reportRule("baseline（現行）: scoreMargin>=10のみ", () => true);
  reportRule(
    "候補A: scoreMargin>=10 かつ abilityGap<5 かつ 最接近ライバル逃/両 のレースを除外",
    (c) => !(c.abilityGap < 5 && isBadRival(c))
  );
  reportRule(
    "候補B: scoreMargin>=10 かつ abilityGap<3 かつ 最接近ライバル逃/両 のレースを除外（より絞った条件）",
    (c) => !(c.abilityGap < 3 && isBadRival(c))
  );

  console.log(
    "\n--- 参考: 除外される候補A分（abilityGap<5×逃/両）単体の成績（top10/日キャップ適用前のフラット集計） ---"
  );
  const removedA = margin10Pop.filter((c) => c.abilityGap < 5 && isBadRival(c));
  console.log(`  n=${removedA.length} ${bandStats(removedA)}`);
  console.log(
    "--- 参考: 除外される候補B分（abilityGap<3×逃/両）単体の成績 ---"
  );
  const removedB = margin10Pop.filter((c) => c.abilityGap < 3 && isBadRival(c));
  console.log(`  n=${removedB.length} ${bandStats(removedB)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
