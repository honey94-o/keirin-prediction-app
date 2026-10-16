"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { EventRaceTab } from "../lib/queries/race";

export function RaceSwitcher({
  races,
  currentRaceId,
}: {
  /** 同じ開催のレース（レース番号順）。finished=着順確定済みのタブは淡色表示にする。 */
  races: EventRaceTab[];
  currentRaceId: number;
}) {
  const activeRef = useRef<HTMLAnchorElement>(null);
  // 触れた（タップし始めた・マウスを載せた）タブだけ先読みを有効にする。
  const [intentRaceId, setIntentRaceId] = useState<number | null>(null);

  // レース切り替えのたびにページ遷移＝タブ帯のDOMも作り直されるため、スクロール位置が
  // 毎回先頭にリセットされてしまう（11R→12Rと進みたいのに1Rまで戻る問題）。
  // 選択中のタブを毎回スクロール位置に入れて、続けて隣のレースへ進みやすくする。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentRaceId]);

  if (races.length <= 1) return null;

  const currentIdx = races.findIndex((r) => r.id === currentRaceId);

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4">
      {races.map((r, i) => {
        const active = r.id === currentRaceId;
        const finished = !active && r.finished;
        // 先読みは前後のレースと触れたタブだけ。画面に見えている全タブを先読みすると、
        // 結果同期でキャッシュが失効するたびに未表示のレースまで生成し直すことになり
        // （1レース約10クエリ）、Neonの転送量を無駄に使うため。
        const prefetch = (!active && Math.abs(i - currentIdx) === 1) || intentRaceId === r.id ? null : false;
        return (
          <Link
            key={r.id}
            ref={active ? activeRef : undefined}
            href={`/races/${r.id}`}
            prefetch={prefetch}
            onTouchStart={() => setIntentRaceId(r.id)}
            onMouseEnter={() => setIntentRaceId(r.id)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium font-mono ${
              active
                ? "bg-mint text-mint-ink"
                : finished
                  ? "bg-white/5 text-mist-3"
                  : "bg-white/5 text-mist-2"
            }`}
          >
            {r.raceNo}R
          </Link>
        );
      })}
    </div>
  );
}
