import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../../lib/predict";
import { formatFormationNotation } from "../../../../lib/scoring";
import { getScenarioStats, getRacesForEvent } from "../../../../lib/repository";
import { MarkBadge } from "../../../../components/MarkBadge";
import { CarNumberBadge } from "../../../../components/CarNumberBadge";
import { RaceSwitcher } from "../../../../components/RaceSwitcher";

export default async function RaceBetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raceId = Number(id);
  const prediction = await predictRace(raceId);
  if (!prediction) notFound();

  const { race, scored, scenarios, boxSuggestion, winSuggestion } = prediction;
  const top4 = scored.slice(0, 4);
  const scenarioStats = await getScenarioStats();
  const eventRaces = await getRacesForEvent(race.kaisai_date, race.jocd);

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href={`/races/${race.id}`} className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← 出走表に戻る
      </Link>
      <RaceSwitcher races={eventRaces} currentRaceId={race.id} linkSuffix="/bets" />
      <h1 className="text-lg font-bold mb-1">
        {race.keirinjo_name} {race.race_no}R 買い目提案
      </h1>
      <p className="text-xs text-gray-400 mb-4">
        展開の分かれ目ごとに複数パターンを提示（参考値）
      </p>

      <div className="flex gap-2 mb-4 flex-wrap">
        {top4.map((s) => (
          <div key={s.entry.entry_id} className="flex items-center gap-1 bg-white rounded-full pl-1 pr-2 py-1 shadow-sm">
            <MarkBadge mark={s.mark} />
            <CarNumberBadge carNum={s.entry.car_num} size="sm" />
            <span className="text-sm">{s.entry.name}</span>
          </div>
        ))}
      </div>

      {winSuggestion && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold bg-amber-500 text-white px-2 py-0.5 rounded-full">
              単勝おすすめ
            </span>
            <span className="text-sm font-semibold">
              軸 {winSuggestion.carNum}. {winSuggestion.name}
            </span>
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
            return (
              <section key={scenario.label} className="bg-white rounded-lg shadow-sm p-4">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs font-semibold bg-[#0d5c3f] text-white px-2 py-0.5 rounded-full">
                    {scenario.label}
                  </span>
                  <span className="text-sm font-semibold">
                    軸 {scenario.axisCarNum}. {scenario.axisName}
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">
                    {scenario.formation.combinations.length}点
                  </span>
                </div>

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
              <h2 className="font-semibold mb-2">
                {boxSuggestion.betType}
                <span className="text-xs text-gray-400 font-normal ml-2">
                  {boxSuggestion.combinations.length}点
                </span>
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
