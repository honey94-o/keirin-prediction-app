"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { RaceRow } from "../lib/types";

export function RaceSwitcher({
  races,
  currentRaceId,
  linkSuffix = "",
}: {
  races: RaceRow[];
  currentRaceId: number;
  /** 遷移先のパス末尾（例: "/bets"）。省略時は出走表画面（/races/[id]）に遷移する。 */
  linkSuffix?: string;
}) {
  const activeRef = useRef<HTMLAnchorElement>(null);

  // レース切り替えのたびにページ遷移＝タブ帯のDOMも作り直されるため、スクロール位置が
  // 毎回先頭にリセットされてしまう（11R→12Rと進みたいのに1Rまで戻る問題）。
  // 選択中のタブを毎回スクロール位置に入れて、続けて隣のレースへ進みやすくする。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentRaceId]);

  if (races.length <= 1) return null;

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3 -mx-4 px-4">
      {races.map((r) => {
        const active = r.id === currentRaceId;
        return (
          <Link
            key={r.id}
            ref={active ? activeRef : undefined}
            href={`/races/${r.id}${linkSuffix}`}
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
