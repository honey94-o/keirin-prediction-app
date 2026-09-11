"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { RaceRow } from "../lib/types";

export function RaceSwitcher({
  races,
  currentRaceId,
  finishedRaceIds,
}: {
  races: RaceRow[];
  currentRaceId: number;
  /** 着順確定済みのレースID集合。渡された場合、終了済みタブを淡色表示にする。 */
  finishedRaceIds?: Set<number>;
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
    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4">
      {races.map((r) => {
        const active = r.id === currentRaceId;
        const finished = !active && (finishedRaceIds?.has(r.id) ?? false);
        return (
          <Link
            key={r.id}
            ref={active ? activeRef : undefined}
            href={`/races/${r.id}`}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium font-mono ${
              active
                ? "bg-mint text-mint-ink"
                : finished
                  ? "bg-white/5 text-mist-5"
                  : "bg-white/5 text-mist-2"
            }`}
          >
            {r.race_no}R
          </Link>
        );
      })}
    </div>
  );
}
