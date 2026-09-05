import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../../lib/predict";
import { formatFormationNotation } from "../../../../lib/scoring";
import {
  getScenarioStats,
  getRacesForEvent,
  getVenueKimariteRank,
  getResultsForRace,
  getResultsForRaces,
  getOddsForRace,
  resolveActualCombo,
  isRaceFinished,
} from "../../../../lib/repository";
import { MarkBadge } from "../../../../components/MarkBadge";
import { CarNumberBadge } from "../../../../components/CarNumberBadge";
import { RecentFormBadge } from "../../../../components/RecentFormBadge";
import { RaceSwitcher } from "../../../../components/RaceSwitcher";
import { BankKimariteCard } from "../../../../components/BankKimariteCard";
import { buildWinticketResultUrl } from "../../../../lib/winticket";

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
  const eventResults = await getResultsForRaces(eventRaces.map((r) => r.id));
  const finishedRaceIds = new Set(
    eventRaces.filter((r) => isRaceFinished(eventResults.get(r.id) ?? [])).map((r) => r.id)
  );

  // レースが終わっていれば実際の着順・的中判定を表示する。actualComboの解決は
  // lib/accuracy.tsのcomputeRaceSummary・scripts/backtest.tsと同じロジック
  // （3連単払戻オッズの組み合わせを最優先、無ければresults.finish_posから組み立て）。
  const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
  const nameByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.name]));
  const snumByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.snum]));

  // ライン構成：先頭→番手→3番手の順に並べる。scoredは既にtotalScore降順のため、
  // Mapの挿入順を使うだけで「◎を含むラインが先頭に来る」表示順になる。
  const LINE_POSITION_ORDER: Record<string, number> = { 先頭: 0, 番手: 1, "3番手": 2 };
  const lineGroups = new Map<number, typeof scored>();
  const soloEntries: typeof scored = [];
  for (const s of scored) {
    if (s.entry.line_group == null) {
      soloEntries.push(s);
      continue;
    }
    const arr = lineGroups.get(s.entry.line_group) ?? [];
    arr.push(s);
    lineGroups.set(s.entry.line_group, arr);
  }
  const lines = [...lineGroups.values()].map((members) =>
    [...members].sort(
      (a, b) =>
        (LINE_POSITION_ORDER[a.entry.line_position ?? ""] ?? 9) -
        (LINE_POSITION_ORDER[b.entry.line_position ?? ""] ?? 9)
    )
  );
  const finishOrder = results
    .filter((r) => r.finish_pos != null)
    .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
  const top3Results = finishOrder.filter((r) => (r.finish_pos ?? 0) <= 3);
  const raceFinished = isRaceFinished(results);
  const actualCombo = raceFinished ? resolveActualCombo(results, odds) : null;
  const sanrentanHitOdds =
    actualCombo != null
      ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null)
      : null;
  // WINTICKETのレース結果ページ（決まり手・レース映像あり）。開催場のスラッグが
  // 未判明の場合（lib/winticket.ts参照）やencpが無い場合はnullになりリンクを出さない。
  // 結果未確定でも出す：うちのDB側の結果反映（daily-sync.yml・sync_results_only.py）
  // より先にWINTICKET本家で結果が出ていることがあるため、その場で直接確認できるように。
  const winticketUrl = buildWinticketResultUrl(race);
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
      <RaceSwitcher
        races={eventRaces}
        currentRaceId={race.id}
        linkSuffix="/bets"
        finishedRaceIds={finishedRaceIds}
      />
      <h1 className="text-lg font-bold mb-1">
        {race.keirinjo_name} {race.race_no}R 買い目提案
        {race.start_time && (
          <span className="text-sm font-normal text-gray-500 ml-2">発走 {race.start_time}</span>
        )}
      </h1>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-400">
          展開の分かれ目ごとに複数パターンを提示（参考値）
        </p>
        {winticketUrl && (
          <a
            href={winticketUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#0d5c3f] underline whitespace-nowrap ml-2 shrink-0"
          >
            WINTICKETで{raceFinished ? "結果・映像を見る" : "確認する"} →
          </a>
        )}
      </div>

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

      {lines.length > 0 && (
        <section className="bg-white rounded-lg shadow-sm p-3 mb-4">
          <h2 className="text-xs font-semibold text-gray-500 mb-2">ライン構成</h2>
          <div className="flex flex-col gap-1.5">
            {lines.map((members) => (
              <div key={members[0].entry.line_group} className="flex items-center gap-1">
                {members.map((s, i) => (
                  <div key={s.entry.car_num} className="flex items-center gap-1">
                    {i > 0 && <span className="text-gray-300 text-xs">-</span>}
                    <CarNumberBadge carNum={s.entry.car_num} size="sm" />
                  </div>
                ))}
                <span className="text-xs text-gray-400 ml-1 truncate">
                  {members.map((s) => s.entry.name).join("・")}
                </span>
              </div>
            ))}
            {soloEntries.length > 0 && (
              <div className="flex items-center gap-1.5 pt-1 border-t border-gray-100">
                <span className="text-xs text-gray-400 shrink-0">単騎</span>
                {soloEntries.map((s) => (
                  <CarNumberBadge key={s.entry.car_num} carNum={s.entry.car_num} size="sm" />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

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
