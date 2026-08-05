import Link from "next/link";
import { notFound } from "next/navigation";
import { getRacesForEvent } from "../../../lib/repository";
import { predictRace } from "../../../lib/predict";
import { HIGH_CONFIDENCE_MARGIN } from "../../../lib/scoring";

export const dynamic = "force-dynamic";

export default async function VenueRacesPage({
  params,
}: {
  params: Promise<{ jocd: string }>;
}) {
  const { jocd } = await params;

  // 開催場選択（ステップ1）から来た当日開催分のレース選択（ステップ2）。
  // 予想計算（predictRace）はこの開催場のレース分だけに絞って行う（以前の
  // トップ画面は全開催場×全レースで呼んでいたため重かった。1開催場なら
  // 7〜12レース程度で済むため「高信頼度」バッジ表示とのバランスを取れる）。
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const races = await getRacesForEvent(todayStr, jocd);
  if (races.length === 0) notFound();

  const first = races[0];

  const highConfidenceRaceIds = new Set<number>();
  await Promise.all(
    races.map(async (race) => {
      const prediction = await predictRace(race.id);
      if (!prediction || prediction.scored.length < 2) return;
      const margin = prediction.scored[0].totalScore - prediction.scored[1].totalScore;
      if (margin >= HIGH_CONFIDENCE_MARGIN) highConfidenceRaceIds.add(race.id);
    })
  );

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href="/" className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← 開催場選択に戻る
      </Link>
      <h1 className="text-lg font-bold mb-4">{first.keirinjo_name} レースを選択</h1>

      <ul className="flex flex-col gap-2">
        {races.map((race) => (
          <li key={race.id}>
            <Link
              href={`/races/${race.id}/bets`}
              className="flex items-center justify-between bg-white rounded-lg shadow-sm px-4 py-3 active:bg-gray-50"
            >
              <span className="font-medium text-gray-900 flex items-center gap-1.5">
                {race.race_no}R
                {highConfidenceRaceIds.has(race.id) && (
                  <span className="text-[10px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">
                    高信頼度
                  </span>
                )}
              </span>
              <span className="text-sm text-gray-500">
                {race.syumoku ?? ""} {race.grade_kbn ?? ""}
              </span>
              <span className="text-sm text-gray-400">{race.start_time ?? ""}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
