import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../lib/predict";
import {
  getPredictionsForRace,
  getRacesForEvent,
  getResultsForRaces,
  isRaceFinished,
} from "../../../lib/repository";
import { recordPredictionAction } from "../../../lib/actions";
import { CarNumberBadge } from "../../../components/CarNumberBadge";
import { MarkBadge } from "../../../components/MarkBadge";
import { RecentFormBadge } from "../../../components/RecentFormBadge";
import { ScoreBar } from "../../../components/ScoreBar";
import { RaceSwitcher } from "../../../components/RaceSwitcher";

function formatDate(kaisaiDate: string): string {
  const y = kaisaiDate.slice(0, 4);
  const m = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  return `${y}/${m}/${d}`;
}

export default async function RaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raceId = Number(id);
  const prediction = await predictRace(raceId);
  if (!prediction) notFound();

  const { race, bankInfo, scored, scenarios } = prediction;
  const alreadyRecorded = (await getPredictionsForRace(raceId)).length > 0;
  const recordPredictionForRace = recordPredictionAction.bind(null, raceId);
  const eventRaces = await getRacesForEvent(race.kaisai_date, race.jocd);
  const eventResults = await getResultsForRaces(eventRaces.map((r) => r.id));
  const finishedRaceIds = new Set(
    eventRaces.filter((r) => isRaceFinished(eventResults.get(r.id) ?? [])).map((r) => r.id)
  );

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <RaceSwitcher races={eventRaces} currentRaceId={race.id} finishedRaceIds={finishedRaceIds} />
      <div className="mb-4">
        <h1 className="text-lg font-bold dark:text-gray-100">
          {race.keirinjo_name} {race.race_no}R
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {formatDate(race.kaisai_date)} {race.syumoku ?? ""} {race.grade_kbn ?? ""}
          {race.kyori ? ` ${race.kyori}m` : ""}
          {race.shukai ? ` ${race.shukai}周` : ""}
          {race.start_time ? ` 発走${race.start_time}` : ""}
        </p>
        {bankInfo && (
          <p className="text-xs text-gray-400 mt-1 dark:text-gray-500">
            バンク: 周長{bankInfo.shuutyou}m 直線{bankInfo.tyokusen} 決まり手(逃
            {bankInfo.nige_pct}% 捲{bankInfo.makuri_pct}% 差{bankInfo.sashi_pct}%)
          </p>
        )}
      </div>

      <Link
        href={`/races/${race.id}/bets`}
        className="block mb-2 text-center bg-[#0d5c3f] text-white rounded-lg py-2 font-semibold active:opacity-80"
      >
        買い目提案を見る
      </Link>

      {alreadyRecorded ? (
        <p className="mb-4 text-center text-sm text-gray-400 border border-gray-200 rounded-lg py-2 dark:text-gray-500 dark:border-gray-700">
          この予想は記録済みです（
          <Link href="/history" className="underline dark:text-emerald-400">
            履歴を見る
          </Link>
          ）
        </p>
      ) : (
        <form action={recordPredictionForRace} className="mb-4">
          <button
            type="submit"
            className="w-full text-center bg-white border border-[#0d5c3f] text-[#0d5c3f] rounded-lg py-2 font-semibold active:opacity-70 dark:bg-gray-800 dark:text-emerald-400 dark:border-emerald-700"
          >
            この予想を記録する
          </button>
          <p className="text-xs text-gray-400 mt-1 text-center dark:text-gray-500">
            発走前に記録しておくと、結果確定後に的中率・回収率を振り返れます
          </p>
        </form>
      )}

      <div className="flex flex-col gap-3">
        {scored.map((s) => (
          <div key={s.entry.entry_id} className="bg-white rounded-lg shadow-sm p-3 dark:bg-gray-800">
            <div className="flex items-center gap-2 mb-2">
              <MarkBadge mark={s.mark} />
              <CarNumberBadge carNum={s.entry.car_num} />
              <Link
                href={`/racers/${s.entry.snum}`}
                className="font-semibold flex-1 truncate dark:text-gray-100"
              >
                {s.entry.name}
              </Link>
              <RecentFormBadge avgFinish={s.recentFormAvg} />
              <span className="text-xl font-bold tabular-nums dark:text-gray-100">
                {s.totalScore.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-2 dark:text-gray-400">
              <span>
                {s.entry.class_rank ?? "-"} / {s.entry.kyakushitsu ?? "-"}
              </span>
              {s.entry.line_group != null && (
                <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
                  ライングループ{s.entry.line_group} ・ {s.entry.line_position}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <ScoreBar label="ライン" score={s.lineScore.score} />
              <ScoreBar label="脚質実力" score={s.kyakushitsuScore.score} />
              <ScoreBar label="データ統計" score={s.statsScore.score} />
            </div>
          </div>
        ))}
      </div>

      {scenarios.length === 0 && scored.length < 3 && (
        <p className="text-xs text-gray-400 mt-4 text-center dark:text-gray-500">
          出走数が少ないため買い目候補は生成されません。
        </p>
      )}
    </main>
  );
}
