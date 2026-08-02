import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../../lib/predict";
import { formatFormationNotation } from "../../../../lib/scoring";
import { MarkBadge } from "../../../../components/MarkBadge";
import { CarNumberBadge } from "../../../../components/CarNumberBadge";

export default async function RaceBetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raceId = Number(id);
  const prediction = await predictRace(raceId);
  if (!prediction) notFound();

  const { race, scored, betSuggestions } = prediction;
  const top4 = scored.slice(0, 4);

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href={`/races/${race.id}`} className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← 出走表に戻る
      </Link>
      <h1 className="text-lg font-bold mb-1">
        {race.keirinjo_name} {race.race_no}R 買い目提案
      </h1>
      <p className="text-xs text-gray-400 mb-4">総合スコア上位から自動生成（参考値）</p>

      <div className="flex gap-2 mb-4 flex-wrap">
        {top4.map((s) => (
          <div key={s.entry.entry_id} className="flex items-center gap-1 bg-white rounded-full pl-1 pr-2 py-1 shadow-sm">
            <MarkBadge mark={s.mark} />
            <CarNumberBadge carNum={s.entry.car_num} size="sm" />
            <span className="text-sm">{s.entry.name}</span>
          </div>
        ))}
      </div>

      {betSuggestions.length === 0 ? (
        <p className="text-sm text-gray-500">出走数が少ないため買い目候補は生成されません。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {betSuggestions.map((suggestion) => {
            const notation =
              suggestion.betType === "3連単フォーメーション"
                ? formatFormationNotation(suggestion.combinations)
                : null;

            return (
              <section key={suggestion.betType} className="bg-white rounded-lg shadow-sm p-4">
                <h2 className="font-semibold mb-2">
                  {suggestion.betType}
                  <span className="text-xs text-gray-400 font-normal ml-2">
                    {suggestion.combinations.length}点
                  </span>
                </h2>

                {notation ? (
                  <>
                    <p className="text-2xl font-bold tabular-nums font-mono text-[#0d5c3f] mb-1">
                      {notation}
                    </p>
                    <p className="text-xs text-gray-400 mb-3">
                      軸-2着候補-3着候補（車番を連結表記。車券購入時にそのまま入力可能）
                    </p>
                  </>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {suggestion.combinations.map((combo) => (
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
        </div>
      )}
    </main>
  );
}
