import { readFileSync, existsSync } from "node:fs";
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
 * 【検証結果: 52.3%(n=16)は正常な小サンプル変動。honmeiFormationHighMargin
 * 導入後の現行ロジックは大サンプルでは黒字（全体109.3%・test120.5%）で、
 * 91.3%/117%/120%という既存の検証結果とも整合する。日別上位10件という
 * 「厳選」特有の選定メカニズム自体に構造的な劣化要因は見つからなかった】
 *
 * ■ 背景・問い
 * 2026-09-11のhonmeiFormationHighMargin導入後、daily_picks実績（margin>=10の
 * 実際の厳選ピック）は2026-09-11〜16の16件で8的中(50%)・回収率52.3%と、
 * lib/repository.tsのDAILY_PICKS_MIN_MARGINコメントが引く91.3%（旧ロジック、
 * 106日）はもちろん、lib/scoring.tsのHIGH_MARGIN_TIGHT_THRESHOLDコメントが引く
 * 117%/test120%（新ロジック、predictions由来537件）からも大きく下回って見えた。
 * ただしn=16は極小で、このプロジェクトでは「厳選のROIは稀な高配当的中に
 * 集中するため数日〜数週間の窓では見た目が大きく振れる」ことが
 * scripts/diagnose-line-count.ts・scripts/diagnose-girls-margin-band.tsで
 * 繰り返し確認されている。117%/120%という数字自体も「開催日で2/3・1/3に
 * 分割したtrain/test」ではあるが「実際のgetDailyPicksの日別上位10件選定」を
 * 経由したシミュレーションではない（lib/scoring.ts L1817-1827のコメント参照：
 * 「predictions由来537件」はmargin>=10を満たす全レースをフラットに集計した
 * 数字で、旧ロジック時代に「実運用の厳選（毎日margin上位10件）」が
 * 平均15.8点・回収率30%・33日で-12.6万円という、フラット集計とは全く違う
 * 実績だった前例がある＝フラット集計とtop10/日選定は別物になりうる）。
 * この2つを区別せずに52.3%(n=16)と比較していたのが混乱の一因だった可能性がある。
 *
 * ■ 方法
 * predictions テーブルは今回の検証には使えないと判明した：predicted_atを
 * 確認したところ、encp LIKE 'wt:%'・本命formation有りの12,063件中、
 * 8,929件（20260409-20260809相当）はpredicted_at 2026-09-07（=
 * honmeiFormationHighMargin導入前の古いロジックのスナップショット）のまま、
 * post-0911（2026-09-11以降にpredicted_at更新＝現行ロジック）は3,134件のみで、
 * かつその内訳も20260810-20260915はほぼ全件更新済みだが20260409-20260715は
 * 1日6-12件程度のまばらな部分更新（別の診断スクリプトの副産物と見られる）で、
 * 161日均一の「現行ロジックのみ」の集合を作れなかった。そのため
 * scripts/diagnose-honmei-highmargin-rule.tsと同じ方式（predictionsテーブルを
 * 使い回さず、predictRaceを実レースIDに対して直接再実行し常に現行コードで
 * 予想を作り直す）で、encp LIKE 'wt:%'・結果確定済み全12,131レース
 * （20260409-20260916、161日）に対してpredictRaceをフルスキャンした
 * （BATCH=25並列、実測41.7分）。
 * 候補の除外基準はscripts/compute-picks.tsのdailyPicks構築と完全に同一：
 * raceStage()==='予選'除外・9人立て(scored.length===9)除外・「本命」
 * シナリオ必須。的中判定・オッズ解決はresolveActualCombo（lib/repository.ts、
 * scripts/backtest.ts等と同じ）。ガールズ判定はisGirlsRaceと同じ
 * （scored.some(class_rank startsWith "L")、scripts/diagnose-girls-margin-band.ts
 * と同一基準）。train/testはこのプロジェクトの標準（開催日で2/3・1/3、
 * 分割日20260725）。
 *
 * ■ サンプルサイズ
 * 厳選候補（除外後）: 8,261件（予選除外3,274 / 9人立て除外595 /
 * 本命formation無し除外0 / 対抗無し除外0 / 結果未確定除外1）。
 * うちmargin>=10（実際のgetDailyPicks選定＝日別上位10件）: 560件/161日
 * （train358件・test202件）。1日平均ピック数3.66件・平均点数6.8点
 * （このプロジェクトの目安=診断あたり最低30件程度を大きく超える規模）。
 *
 * ■ 結果(A): 実運用シミュレーション（margin>=10・日別上位10件、getDailyPicks再現）
 *   全体: n=560 的中43.9%(246/560) 回収率109.3% 損益+35,250円
 *   train: n=358 的中45.3%(162/358) 回収率103.3% 損益+8,230円
 *   test : n=202 的中41.6%(84/202) 回収率120.5% 損益+27,020円
 *   → train・testとも黒字で、testはtrainよりむしろ改善（過学習の兆候なし）。
 *   91.3%（旧ロジック・106日）比+18.0pt、117%/test120%（新ロジック・フラット
 *   537件）比では全体がやや低い（109.3%<117%）ものの、testは120.5%と
 *   ほぼ完全に一致した。フラット集計とtop10/日選定で数字がずれること自体は
 *   前述の「旧ロジック時代の30% vs 105%」の前例に比べればずっと小さい差で、
 *   このプロジェクトが黒字/赤字の境界として重視する100%ラインは
 *   train/testとも一貫して上回っている。
 *
 *   ガールズ/非ガールズ内訳（実際に選ばれたtop10/日の中で分割）:
 *     [全体]  ガールズ n=221 的中54.3%(120/221) 回収率90.6%  損益-12,530円
 *     [全体]  非ガールズ n=339 的中37.2%(126/339) 回収率119.3% 損益+47,780円
 *     [train] ガールズ n=134 的中58.2%(78/134)  回収率104.6% 損益+3,670円
 *     [train] 非ガールズ n=224 的中37.5%(84/224) 回収率102.7% 損益+4,560円
 *     [test]  ガールズ n=87  的中48.3%(42/87)  回収率69.0%  損益-16,200円
 *     [test]  非ガールズ n=115 的中36.5%(42/115) 回収率154.2% 損益+43,220円
 *   → train期はガールズ・非ガールズともほぼ均衡（104.6%/102.7%）だが、
 *   testに入るとガールズが69.0%まで沈み、非ガールズが154.2%まで伸びる方向へ
 *   分岐した。全体の黒字（120.5%）は非ガールズの伸びが牽引しており、
 *   ガールズ単体はtest期間だけを見ると赤字（69.0%）。
 *
 * ■ 直近の実績(n=16, 2026-09-11〜16)との整合性チェック
 *   ユーザーが指摘した直近の実績はガールズn=11・回収率65.9%、非ガールズn=5・
 *   回収率25.9%だった。この6日間はtest期間(20260725〜20260916)の末尾に完全に
 *   含まれる。大サンプルのtest期間のガールズ回収率69.0%(n=87)は直近n=11の
 *   65.9%と非常に近く、ガールズ側の「悪化傾向」はこの大サンプルでも
 *   同じ方向に再現された、一貫した信号の可能性がある。
 *   一方、非ガールズは大サンプルのtest期間が154.2%(n=115)と大幅黒字なのに対し、
 *   直近n=5だけを見ると25.9%と対照的に悪い——n=5という極小サンプルでの
 *   単発の不運（この規模の回収率は稀な高配当的中1回の有無で数十〜100pt以上
 *   動きうる、diagnose-line-count.ts等で繰り返し確認済みの力学）で説明でき、
 *   非ガールズ側の直近の悪さを「現行ロジックの劣化」と解釈する根拠はない。
 *
 * ■ 結果(B) / Step3: 日別上限（top10/日）キャップの寄与を分離
 *   margin>=10で「1日10件を超えた日」: 161日中0日。そのため(A)実運用
 *   シミュレーションと(B)日別上限なし・margin>=10を全件フラット集計は
 *   全体・train・test・ガールズ/非ガールズ内訳のすべてで完全に同一の数字に
 *   なった（n=560で一致）。
 *   → 「日別上位10件」という厳選特有の貪欲な選定メカニズムは、この
 *   161日間で一度もキャップとして機能しておらず、選定結果を一切歪めて
 *   いない。Step3で懸念されていた「その日の候補が薄いだけで小粒な候補が
 *   紛れ込む」という仮説上のメカニズムは、そもそも発動する余地がなく
 *   （margin>=10自体が1日平均3.66件しか出ない厳しい閾値のため）、今回の
 *   分析対象からは棄却される。今の厳選の実績は実質「margin>=10というマクロな
 *   閾値そのものの成績」であり、日次キャップの副作用ではない。
 *
 * ■ 結論
 * 直近16件・回収率52.3%は、大サンプル・現行ロジック・実運用と同じ
 * 日別top10選定を通した検証（n=560、train103.3%/test120.5%）と比較すると
 * 正常な変動の範囲内であり、体系的な問題が現行ロジックに新たに生じたとは
 * 言えない。91.3%（旧ロジック）比で明確に改善しており、117%/120%
 * （新ロジックのフラット集計）ともtest側でほぼ一致した。日別上位10件の
 * キャップメカニズム自体は161日間一度も発動しておらず、Step3で懸念された
 * 「貪欲な日次選定が構造的に劣った候補を選ぶ」というメカニズムは今回は
 * 確認されなかった（それを問うこと自体がこの母集団では意味をなさない
 * ほどキャップが無風だった）。
 * 唯一、大サンプルでも再現した観察に値する分岐は、train期に拮抗していた
 * ガールズ・非ガールズがtest期に入って逆方向へ分かれたこと（ガールズ
 * 104.6%→69.0%、非ガールズ102.7%→154.2%）。ガールズ側の下降は直近n=11の
 * 65.9%とも整合しており偶然ではない可能性があるが、(1)単一のtrain/test
 * 分割のみに基づく観察であること、(2)非ガールズ側の急伸はガールズの下降と
 * 対称的に見えるだけで独立に検証していないこと、(3)このプロジェクトの
 * 基準（train/testで同方向・再現性）を満たすかは追加の検証（例えば
 * 分割日を変えたクロスチェックや、ガールズ側だけの月別推移）が必要なこと、
 * から、現時点ではlib/scoring.ts・scripts/compute-picks.ts・
 * lib/repository.tsへの変更は一切提案しない。あくまで「今後モニターする
 * 価値がある観察」に留め、対応が必要な問題として扱わない。
 */

import { getDb, closeDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import { getResultsForRace, getOddsForRace, resolveActualCombo, enableReadCache } from "../lib/repository";
import { raceStage } from "../lib/scoring";

const DAILY_PICKS_MIN_MARGIN = 10; // lib/repository.tsのgetDailyPicksと同じ

type Candidate = {
  raceId: number;
  date: string;
  margin: number;
  formation: string[];
  isGirls: boolean;
  actualCombo: string | null;
  hitOdds: number | null;
};

async function main() {
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
  let excludedYosen = 0,
    excluded9car = 0,
    excludedNoFormation = 0,
    excludedNoTaikou = 0,
    excludedNoResult = 0;

  const BATCH = 25;
  const startTime = Date.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const out = await Promise.all(
      chunk.map(async (raceId): Promise<Candidate | null> => {
        const p = await predictRace(raceId);
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
        const honmei = p.scored[0];
        const taikou = p.scored[1];
        const margin = honmei.totalScore - taikou.totalScore;
        const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
        const actualCombo = resolveActualCombo(results, odds);
        if (actualCombo == null) {
          excludedNoResult++;
          return null;
        }
        const hitOdds =
          odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null;
        const isGirls = p.scored.some((s) => s.entry.class_rank?.startsWith("L"));
        return {
          raceId,
          date: p.race.kaisai_date,
          margin,
          formation: honmeiScenario.formation.combinations,
          isGirls,
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
      `本命formation無し除外${excludedNoFormation} / 対抗無し除外${excludedNoTaikou} / 結果未確定除外${excludedNoResult}）`
  );

  const dates = [...new Set(candidates.map((c) => c.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(
    `対象日数: ${dates.length}日（${dates[0]}〜${dates.at(-1)}） train/test分割日: ${split}`
  );

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

  const isAllD = (_d: string) => true;
  const isTrainD = (d: string) => d < split;
  const isTestD = (d: string) => d >= split;

  // ---- (A) 実際のgetDailyPicksと同じ「margin>=10・日別上位10件」シミュレーション ----
  const byDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byDate.get(c.date) ?? [];
    arr.push(c);
    byDate.set(c.date, arr);
  }
  function top10PerDay(dateFilter: (d: string) => boolean): Candidate[] {
    const picked: Candidate[] = [];
    for (const [date, arr] of byDate) {
      if (!dateFilter(date)) continue;
      const top10 = arr
        .filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN)
        .sort((a, b) => b.margin - a.margin)
        .slice(0, 10);
      picked.push(...top10);
    }
    return picked;
  }

  // キャップの発動確認
  let daysOver10 = 0;
  let totalQualifying = 0;
  for (const [, arr] of byDate) {
    const q = arr.filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN).length;
    totalQualifying += q;
    if (q > 10) daysOver10++;
  }
  console.log(
    `\nmargin>=${DAILY_PICKS_MIN_MARGIN}該当: 全${totalQualifying}件 / ${byDate.size}日中、1日10件超の日: ${daysOver10}日`
  );

  console.log("\n========== (A) 実運用シミュレーション: margin>=10・日別上位10件（getDailyPicks再現） ==========");
  const capAll = top10PerDay(isAllD);
  const capTrain = top10PerDay(isTrainD);
  const capTest = top10PerDay(isTestD);
  console.log(`全体: n=${capAll.length} ${fmtSel(evalOutcomes(capAll))}`);
  console.log(`train: n=${capTrain.length} ${fmtSel(evalOutcomes(capTrain))}`);
  console.log(`test : n=${capTest.length} ${fmtSel(evalOutcomes(capTest))}`);

  console.log("\n--- (A) ガールズ/非ガールズ内訳（実際に選ばれたtop10/日の中で分割） ---");
  for (const [label, arr] of [
    ["全体", capAll],
    ["train", capTrain],
    ["test", capTest],
  ] as [string, Candidate[]][]) {
    const girls = arr.filter((c) => c.isGirls);
    const nonGirls = arr.filter((c) => !c.isGirls);
    console.log(`  [${label}] ガールズ n=${girls.length} ${fmtSel(evalOutcomes(girls))}`);
    console.log(`  [${label}] 非ガールズ n=${nonGirls.length} ${fmtSel(evalOutcomes(nonGirls))}`);
  }

  // ---- (B) 日別上限なし・margin>=10を全件フラットに集計（日次capの効果を分離） ----
  console.log("\n========== (B) 比較対象: 日別上限なし・margin>=10を全件フラット集計 ==========");
  function flatSet(dateFilter: (d: string) => boolean): Candidate[] {
    return candidates.filter((c) => c.margin >= DAILY_PICKS_MIN_MARGIN && dateFilter(c.date));
  }
  const flatAll = flatSet(isAllD);
  const flatTrain = flatSet(isTrainD);
  const flatTest = flatSet(isTestD);
  console.log(`全体: n=${flatAll.length} ${fmtSel(evalOutcomes(flatAll))}`);
  console.log(`train: n=${flatTrain.length} ${fmtSel(evalOutcomes(flatTrain))}`);
  console.log(`test : n=${flatTest.length} ${fmtSel(evalOutcomes(flatTest))}`);

  console.log("\n--- (B) ガールズ/非ガールズ内訳（フラット集計） ---");
  for (const [label, arr] of [
    ["全体", flatAll],
    ["train", flatTrain],
    ["test", flatTest],
  ] as [string, Candidate[]][]) {
    const girls = arr.filter((c) => c.isGirls);
    const nonGirls = arr.filter((c) => !c.isGirls);
    console.log(`  [${label}] ガールズ n=${girls.length} ${fmtSel(evalOutcomes(girls))}`);
    console.log(`  [${label}] 非ガールズ n=${nonGirls.length} ${fmtSel(evalOutcomes(nonGirls))}`);
  }

  // ---- 参考: 日別ピック数・平均点数 ----
  const avgPicksPerDay = capAll.length / new Set(capAll.map((c) => c.date)).size;
  const avgPointsPerPick = capAll.reduce((a, c) => a + c.formation.length, 0) / capAll.length;
  console.log(
    `\n参考: 実運用シミュレーションの1日平均ピック数=${avgPicksPerDay.toFixed(2)}件 平均点数=${avgPointsPerPick.toFixed(1)}点`
  );

  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
