"use client";

import { minutesBetween } from "../lib/date";
import { useJstNowHHMM, useJstToday } from "./useJstClock";

/** 発走30分以内なら残り分数を返す（当日タブでのみ意味を持つ）。 */
function startingSoonMinutes(
  startTime: string | null,
  viewDate: string,
  todayStr: string,
  nowHHMM: string
): number | null {
  if (viewDate !== todayStr || !startTime) return null;
  const diff = minutesBetween(nowHHMM, startTime);
  return diff >= 0 && diff <= 30 ? diff : null;
}

/**
 * 「あと○分」バッジ。現在時刻で変わるため、CDNにキャッシュするHTMLには含めず
 * （古い残り分数を出さないようサーバー描画では何も出さない）ブラウザで計算する。
 */
export function StartingSoonBadge({ startTime, viewDate }: { startTime: string | null; viewDate: string }) {
  const todayStr = useJstToday(null);
  const nowHHMM = useJstNowHHMM(null);
  if (todayStr == null || nowHHMM == null) return null;
  const minutes = startingSoonMinutes(startTime, viewDate, todayStr, nowHHMM);
  if (minutes == null) return null;
  return (
    <span className="text-[10px] font-bold text-[#2A0A10] bg-rose px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
      あと{minutes}分
    </span>
  );
}
