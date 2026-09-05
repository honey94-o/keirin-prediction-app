"use client";

import { useRouter } from "next/navigation";

export interface VenueOption {
  jocd: string;
  keirinjoName: string;
  /** 選択時に飛ぶ先（その開催場の「今行くならこのレース」1件、lib/scoring.tsのpickNearestRace参照）。 */
  targetRaceId: number;
}

/**
 * 買い目提案画面から他の開催場へ直接飛べる小さなドロップダウン。
 * 同日開催の全開催場を選択肢にし、選ぶとその開催場の直近レースの
 * 買い目提案へ遷移する（トップに戻らなくても開催場を横に移動できるように）。
 */
export function VenueSwitcher({
  venues,
  currentJocd,
}: {
  venues: VenueOption[];
  currentJocd: string;
}) {
  const router = useRouter();

  if (venues.length <= 1) return null;

  return (
    <select
      value={currentJocd}
      onChange={(e) => {
        const target = venues.find((v) => v.jocd === e.target.value);
        if (target) router.push(`/races/${target.targetRaceId}/bets`);
      }}
      className="text-xs font-semibold bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 shrink-0 max-w-[8rem] dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300"
    >
      {venues.map((v) => (
        <option key={v.jocd} value={v.jocd}>
          {v.keirinjoName}
        </option>
      ))}
    </select>
  );
}
