"use client";

import type { ReactNode } from "react";
import { StartingSoonBadge } from "./StartingSoonBadge";
import { useJstNowHHMM, useJstToday } from "./useJstClock";
import { IntentLink } from "./IntentLink";

export interface VenueCardRace {
  id: number;
  raceNo: number;
  startTime: string | null;
  /** lib/scoring.tsのraceStage(syumoku)（クライアントにscoring.tsを読み込まないようサーバーで計算して渡す）。 */
  stage: string;
}

/**
 * lib/scoring.tsのpickNearestRaceと同じ選び方（現在時刻を引数で受け取る版）。
 * 当日ならまだ発走していない一番近いレース（無ければ最終レース）、翌日以降なら最初の
 * レース、前日以前なら最終レース。races は開催場内のレース番号順で渡すこと（同時刻の並びを保つ）。
 */
function pickNearest(races: VenueCardRace[], viewDate: string, todayStr: string, nowHHMM: string): VenueCardRace {
  const sorted = [...races].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  if (viewDate === todayStr) {
    const upcoming = sorted.find((r) => (r.startTime ?? "") >= nowHHMM);
    return upcoming ?? sorted[sorted.length - 1];
  }
  if (viewDate > todayStr) return sorted[0];
  return sorted[sorted.length - 1];
}

/**
 * ホームの開催場カード。「次走」の選択は現在時刻で変わるため、CDNにキャッシュした
 * HTMLでは描画時点の時刻で選んでおき、ブラウザで現在時刻に合わせて選び直す。
 * レースごとの行（結果・的中バッジ）はサーバーで描画してchildrenで受け取る。
 */
export function HomeVenueCard({
  name,
  dayLabel,
  grade,
  gradeClass,
  allFinished,
  viewDate,
  renderToday,
  renderNow,
  races,
  children,
}: {
  name: string;
  dayLabel: string | null;
  grade: string | null;
  gradeClass: string;
  allFinished: boolean;
  viewDate: string;
  renderToday: string;
  renderNow: string;
  races: VenueCardRace[];
  children: ReactNode;
}) {
  const todayStr = useJstToday(renderToday);
  const nowHHMM = useJstNowHHMM(renderNow);
  const nearestRace = pickNearest(races, viewDate, todayStr, nowHHMM);
  const stage = nearestRace.stage;

  return (
    <details
      className={`rounded-[18px] border border-white/[.06] overflow-hidden group ${
        allFinished ? "bg-ink-2 opacity-60" : "bg-ink-3"
      }`}
    >
      <summary className="flex items-center gap-3 p-3.5 cursor-pointer select-none marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="text-lg font-black text-mist-0 shrink-0">{name}</span>
        <div className="flex gap-1.5 flex-1 flex-wrap">
          {dayLabel && (
            <span
              className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                dayLabel === "最終日" ? "text-rose bg-rose/[.14]" : "text-blue bg-blue/[.14]"
              }`}
            >
              {dayLabel}
            </span>
          )}
          {grade && <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${gradeClass}`}>{grade}</span>}
          {stage !== "不明" && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-mint bg-mint/[.12]">{stage}</span>
          )}
          {allFinished && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-mist-3 bg-white/[.07]">終了</span>
          )}
        </div>
        <div className="flex flex-col items-end shrink-0">
          <span className="font-mono text-[13px] text-mist-0">
            {allFinished ? `全${races.length}R` : `${nearestRace.raceNo}R / ${races.length}`}
          </span>
          {!allFinished && nearestRace.startTime && (
            <span className="text-[10px] text-mist-3 flex items-center gap-1">
              発走 {nearestRace.startTime}
              <StartingSoonBadge startTime={nearestRace.startTime} viewDate={viewDate} />
            </span>
          )}
        </div>
        <span className="text-[11px] text-mist-3 group-open:hidden shrink-0">開く ⌄</span>
        <span className="text-[11px] text-mist-3 hidden group-open:inline shrink-0">閉じる ⌃</span>
      </summary>
      <div className="px-3.5 pb-3.5 flex flex-col gap-px">
        <IntentLink
          href={`/races/${nearestRace.id}`}
          className="flex items-center justify-between py-2.5 border-t border-white/[.05] text-mint-strong"
        >
          <span className="text-xs font-semibold">
            {allFinished ? "予想・買い目を見る" : `次走 ${nearestRace.raceNo}Rの予想を見る`}
          </span>
          <span className="text-xs">→</span>
        </IntentLink>
        {children}
      </div>
    </details>
  );
}
