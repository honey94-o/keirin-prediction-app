import Link from "next/link";
import type { RaceRow } from "../lib/types";

export function RaceSwitcher({
  races,
  currentRaceId,
}: {
  races: RaceRow[];
  currentRaceId: number;
}) {
  if (races.length <= 1) return null;

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3 -mx-4 px-4">
      {races.map((r) => {
        const active = r.id === currentRaceId;
        return (
          <Link
            key={r.id}
            href={`/races/${r.id}`}
            className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-semibold ${
              active
                ? "bg-[#0d5c3f] text-white"
                : "bg-white text-gray-600 border border-gray-200"
            }`}
          >
            {r.race_no}R
          </Link>
        );
      })}
    </div>
  );
}
