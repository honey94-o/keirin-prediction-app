import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../../lib/predict";
import { formatFormationNotation } from "../../../../lib/scoring";
import {
  getScenarioStats,
  getRacesForEvent,
  getVenueKimariteRank,
  getResultsForRace,
  getOddsForRace,
  resolveActualCombo,
} from "../../../../lib/repository";
import { MarkBadge } from "../../../../components/MarkBadge";
import { CarNumberBadge } from "../../../../components/CarNumberBadge";
import { RecentFormBadge } from "../../../../components/RecentFormBadge";
import { RaceSwitcher } from "../../../../components/RaceSwitcher";
import { BankKimariteCard } from "../../../../components/BankKimariteCard";

export default async function RaceBetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raceId = Number(id);
  const prediction = await predictRace(raceId);
  if (!prediction) notFound();

  const { race, bankInfo, venueKimarite, scored, scenarios, boxSuggestion, winSuggestion } = prediction;
  const top4 = scored.slice(0, 4);
  const scenarioStats = await getScenarioStats();
  const eventRaces = await getRacesForEvent(race.kaisai_date, race.jocd);
  const kimariteRank = await getVenueKimariteRank(race.jocd);

  // レースが終わっていれば実際の着順・的中判定を表示する。actualComboの解決は
  // lib/accuracy.tsのcomputeRaceSummary・scripts/backtest.tsと同じロジック
  // （3連単払戻オッズの組み合わせを最優先、無ければresults.finish_posから組み立て）。
  const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
  const nameByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.name]));
  const snumByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.snum]));
  const finishOrder = results
    .filter((r) => r.finish_pos != null)
    .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
  const top3Results = finishOrder.filter((r) => (r.finish_pos ?? 0) <= 3);
  const raceFinished = top3Results.length >= 3;
  const actualCombo = raceFinished ? resolveActualCombo(results, odds) : null;
  const sanrentanHitOdds =
    actualCombo != null
      ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null)
      : null;
  const actualTop3Set = new Set(top3Results.map((r) => r.car_num));
  const winnerCarNum = finishOrder.find((r) => r.finish_pos === 1)?.car_num ?? null;
  const sortedActualTop3 =
    actualTop3Set.size === 3 ? [...actualTop3Set].sort((a, b) => a - b).join("-") : null;

  // venues/[jocd]と同じ解決ロジック（自場実績→同周長グループ実績→bank_info静的値）。
  const kimariteRates =
    venueKimarite ??
    (bankInfo?.nige_pct != null && bankInfo?.makuri_pct != null && bankInfo?.sashi_pct != null
      ? { nige_pct: bankInfo.nige_pct, makuri_pct: bankInfo.makuri_pct, sashi_pct: bankInfo.sashi_pct }
      : null);
  const kimariteSourceLabel = venueKimarite
    ? `実績${venueKimarite.races}走`
    : kimariteRates
      ? "参考値(KEIRIN.JP掲載)"
      : null;

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href={`/races/${race.id}`} className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← 出走表に戻る
      </Link>
      <RaceSwitcher races={eventRaces} currentRaceId={race.id} linkSuffix="/bets" />
      <h1 className="text-lg font-bold mb-1">
        {race.keirinjo_name} {race.race_no}R 買い目提案
        {race.start_time && (
          <span className="text-sm font-normal text-gray-500 ml-2">発走 {race.start_time}</span>
        )}
      </h1>
      <p className="text-xs text-gray-400 mb-4">
        展開の分かれ目ごとに複数パターンを提示（参考値）
      </p>

      {kimariteRates && (
        <BankKimariteCard
          rates={kimariteRates}
          ranks={kimariteRank}
          sourceLabel={kimariteSourceLabel}
          featureText={bankInfo?.feature_text}
        />
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {top4.map((s) => (
          <div key={s.entry.entry_id} className="flex items-center gap-1 bg-white rounded-full pl-1 pr-2 py-1 shadow-sm">
            <MarkBadge mark={s.mark} />
            <CarNumberBadge carNum={s.entry.car_num} size="sm" />
            <Link href={`/racers/${s.entry.snum}`} className="text-sm">
              {s.entry.name}
            </Link>
            <RecentFormBadge avgFinish={s.recentFormAvg} />
          </div>
        ))}
      </div>

      {raceFinished && (
        <section className="bg-gray-50 border border-gray-200 rounded-lg shadow-sm p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold bg-gray-600 text-white px-2 py-0.5 rounded-full">
              結果
            </span>
            {actualCombo && (
              <span className="text-sm font-mono font-bold tabular-nums text-gray-900">
                {actualCombo}
              </span>
            )}
            {sanrentanHitOdds != null && (
              <span className="text-xs text-gray-500 ml-auto">
                3連単 {sanrentanHitOdds.toFixed(1)}倍（{(100 * sanrentanHitOdds).toFixed(0)}円）
              </span>
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {top3Results.map((r) => (
              <li key={r.car_num} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-gray-400 w-8 shrink-0">{r.finish_pos}着</span>
                <CarNumberBadge carNum={r.car_num} size="sm" />
                <Link href={`/racers/${snumByCarNum.get(r.car_num)}`} className="text-gray-900 underline">
                  {nameByCarNum.get(r.car_num) ?? "-"}
                </Link>
                {r.finish_pos === 1 && r.kimarite && (
                  <span className="text-xs text-gray-400 ml-auto">{r.kimarite}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {winSuggestion && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold bg-amber-500 text-white px-2 py-0.5 rounded-full">
              単勝おすすめ
            </span>
            <span className="text-sm font-semibold">
              軸 {winSuggestion.carNum}.{" "}
              <Link href={`/racers/${snumByCarNum.get(winSuggestion.carNum)}`} className="underline">
                {winSuggestion.name}
              </Link>
            </span>
            {raceFinished && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-semibold ml-auto ${
                  winnerCarNum === winSuggestion.carNum
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {winnerCarNum === winSuggestion.carNum ? "的中" : "不的中"}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-600">
            対抗とのスコア差が{winSuggestion.margin.toFixed(1)}点あり、この条件では単勝的中率が
            高い傾向（実績81.7%以上）です。3連単を広げるより単勝で勝負するのもおすすめです。
          </p>
        </section>
      )}

      {scenarios.length === 0 ? (
        <p className="text-sm text-gray-500">出走数が少ないため買い目候補は生成されません。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {scenarios.map((scenario) => {
            const notation = formatFormationNotation(scenario.formation.combinations);
            const stat = scenarioStats[scenario.label];
            const scenarioHit = raceFinished && actualCombo != null
              ? scenario.formation.combinations.includes(actualCombo)
              : null;
            const scenarioStakeYen = 100 * scenario.formation.combinations.length;
            const scenarioPayoutYen =
              scenarioHit && sanrentanHitOdds != null ? 100 * sanrentanHitOdds : 0;
            return (
              <section key={scenario.label} className="bg-white rounded-lg shadow-sm p-4">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs font-semibold bg-[#0d5c3f] text-white px-2 py-0.5 rounded-full">
                    {scenario.label}
                  </span>
                  <span className="text-sm font-semibold">
                    軸 {scenario.axisCarNum}.{" "}
                    <Link href={`/racers/${snumByCarNum.get(scenario.axisCarNum)}`} className="underline">
                      {scenario.axisName}
                    </Link>
                  </span>
                  {scenarioHit != null && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                        scenarioHit ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {scenarioHit ? "的中" : "不的中"}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">
                    {scenario.formation.combinations.length}点
                  </span>
                </div>

                {scenarioHit != null && (
                  <p className="text-xs text-gray-500 mb-1">
                    買い目 {scenarioStakeYen}円 ・ 払戻 {scenarioPayoutYen.toFixed(0)}円 ・ 回収率{" "}
                    <span className={scenarioPayoutYen >= scenarioStakeYen ? "text-green-700 font-semibold" : ""}>
                      {((scenarioPayoutYen / scenarioStakeYen) * 100).toFixed(0)}%
                    </span>
                  </p>
                )}

                {scenario.likelyRank >= 2 && (
                  <p className="mb-1">
                    <span
                      className={
                        scenario.likelyRank === 2
                          ? "text-xs font-semibold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full"
                          : "text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full"
                      }
                    >
                      {scenario.likelyRank === 2
                        ? "このレースでは本命に次ぐ有力な展開"
                        : "このレースでは可能性低め"}
                    </span>
                  </p>
                )}

                <p className="text-xs text-gray-500 mb-3">{scenario.reason}</p>

                {stat && stat.races > 0 && (
                  <p className="text-xs mb-3">
                    <span
                      className={
                        stat.roi != null && stat.roi >= 100
                          ? "text-green-700 font-semibold"
                          : "text-gray-400"
                      }
                    >
                      実績: 的中{stat.hitRate.toFixed(1)}%
                      {stat.roi != null ? ` / 回収率${stat.roi.toFixed(0)}%` : ""}
                      （過去{stat.races}レース中{stat.hits}回的中）
                    </span>
                  </p>
                )}

                {notation && (
                  <>
                    <p className="text-2xl font-bold tabular-nums font-mono text-[#0d5c3f] mb-1">
                      {notation}
                    </p>
                    <p className="text-xs text-gray-400 mb-3">
                      軸-2着候補-3着候補（車番を連結表記。車券購入時にそのまま入力可能）
                    </p>
                  </>
                )}

                <div className="flex flex-wrap gap-2">
                  {scenario.formation.combinations.map((combo) => (
                    <span
                      key={combo}
                      className="px-2 py-1 rounded bg-gray-100 text-sm tabular-nums font-mono"
                    >
                      {combo}
                    </span>
                  ))}
                </div>
              </section>
            );
          })}

          {boxSuggestion && boxSuggestion.combinations.length > 0 && (
            <section className="bg-white rounded-lg shadow-sm p-4">
              <h2 className="font-semibold mb-2 flex items-center gap-2">
                {boxSuggestion.betType}
                <span className="text-xs text-gray-400 font-normal">
                  {boxSuggestion.combinations.length}点
                </span>
                {raceFinished && sortedActualTop3 != null && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                      boxSuggestion.combinations.includes(sortedActualTop3)
                        ? "bg-red-100 text-red-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {boxSuggestion.combinations.includes(sortedActualTop3) ? "的中" : "不的中"}
                  </span>
                )}
              </h2>
              <p className="text-xs text-gray-500 mb-3">
                展開に依らず上位{top4.length}車を総当たり（決着順を絞らない保険的な買い方）
              </p>
              <div className="flex flex-wrap gap-2">
                {boxSuggestion.combinations.map((combo) => (
                  <span
                    key={combo}
                    className="px-2 py-1 rounded bg-gray-100 text-sm tabular-nums font-mono"
                  >
                    {combo}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
