"use client";

import { useRouter } from "next/navigation";
import { nowJstHHMM, todayJstStr } from "../lib/date";
import type { VenueRaceOption } from "../lib/queries/race";

/**
 * 選択した開催場で「今行くならこのレース」を選ぶ（lib/scoring.ts pickNearestRace と同じ規則）。
 * 当日ならまだ発走していない一番近いレース（無ければ最終レース）、翌日以降なら最初のレース、
 * 前日以前なら最終レース。races は発走時刻順。
 * 現在時刻で決まるため、キャッシュされるサーバー側のHTMLではなく選択した時点で端末側で決める。
 */
function pickTargetRaceId(races: VenueRaceOption["races"], viewDate: string): number {
  const todayStr = todayJstStr();
  if (viewDate === todayStr) {
    const now = nowJstHHMM();
    const upcoming = races.find(([, startTime]) => (startTime ?? "") >= now);
    return (upcoming ?? races[races.length - 1])[0];
  }
  if (viewDate > todayStr) return races[0][0];
  return races[races.length - 1][0];
}

/**
 * レース詳細画面から他の開催場へ直接飛べる小さなドロップダウン。
 * 同日開催の全開催場を選択肢にし、選ぶとその開催場の直近レースの詳細へ遷移する
 * （トップに戻らなくても開催場を横に移動できるように）。
 */
export function VenueSwitcher({
  venues,
  currentJocd,
  viewDate,
}: {
  venues: VenueRaceOption[];
  currentJocd: string;
  /** 表示中のレースの開催日（YYYYMMDD）。 */
  viewDate: string;
}) {
  const router = useRouter();

  if (venues.length <= 1) return null;

  return (
    <select
      value={currentJocd}
      onChange={(e) => {
        const target = venues.find((v) => v.jocd === e.target.value);
        if (target) router.push(`/races/${pickTargetRaceId(target.races, viewDate)}`);
      }}
      className="text-xs font-semibold bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-mist-2 shrink-0 max-w-[8rem]"
    >
      {venues.map((v) => (
        <option key={v.jocd} value={v.jocd} className="bg-ink-1 text-mist-1">
          {v.keirinjoName}
        </option>
      ))}
    </select>
  );
}
