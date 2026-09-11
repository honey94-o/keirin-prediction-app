"use client";

import { useRouter } from "next/navigation";

export interface VenueOption {
  jocd: string;
  keirinjoName: string;
  /** 選択時に飛ぶ先（その開催場の「今行くならこのレース」1件、lib/scoring.tsのpickNearestRace参照）。 */
  targetRaceId: number;
}

/**
 * レース詳細画面から他の開催場へ直接飛べる小さなドロップダウン。
 * 同日開催の全開催場を選択肢にし、選ぶとその開催場の直近レースの詳細へ遷移する
 * （トップに戻らなくても開催場を横に移動できるように）。
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
        if (target) router.push(`/races/${target.targetRaceId}`);
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
