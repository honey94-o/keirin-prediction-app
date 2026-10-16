"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addDaysToDateStr, formatDateStr, isValidDateStr, todayJstStr } from "../lib/date";
import { useJstToday } from "./useJstToday";
import type { PickHitDay } from "../lib/queries/history";

// /history・/history/[date] はキャッシュされたHTMLを返すため、「今日」で変わる部分だけを
// ここ（端末側）で描く。

/**
 * 「今日の的中（厳選+バリカタ合算）」の直近N日（N＝渡された日数）。本日の行は進行中扱いでホームへ戻す。
 * 生成後に日付をまたいだ場合は、端末の今日から数えたN日に入る日だけを出す。
 */
export function CombinedHistorySection({ days, renderedToday }: { days: PickHitDay[]; renderedToday: string }) {
  const today = useJstToday(renderedToday);
  const windowDays = days.length;
  const oldest = addDaysToDateStr(today, -(windowDays - 1));
  const visible = days.filter((d) => d.date >= oldest && d.date <= today && d.total > 0);
  if (visible.length === 0) return null;
  return (
    <section className="bg-white rounded-lg shadow-sm p-4 mb-4 dark:bg-gray-800">
      <h2 className="font-semibold text-sm text-gray-600 mb-2 dark:text-gray-300">
        今日の的中（厳選+バリカタ合算）・直近{windowDays}日
      </h2>
      <ul className="flex flex-col divide-y divide-gray-100 dark:divide-gray-700">
        {visible.map((d) => (
          <li key={d.date}>
            <Link
              // 「本日」はgetDailySummary側が結果確定済み扱いしないため専用の
              // 日別詳細を持たない。ホーム画面（今まさに進行中のビュー）に戻す。
              href={d.date === today ? "/" : `/history/${d.date}`}
              // 日付ごとのページを一覧の全行ぶん先読みすると、失効のたびに各日の集計を
              // 作り直すことになるため押した時だけ取りに行く。
              prefetch={false}
              className="flex items-center justify-between text-sm py-1.5 active:bg-gray-50 -mx-1 px-1 rounded dark:active:bg-gray-700"
            >
              <span className="text-gray-700 dark:text-gray-300">
                {formatDateStr(d.date)}
                {d.date === today && (
                  <span className="text-xs text-gray-400 ml-1 dark:text-gray-400">(本日・進行中)</span>
                )}
              </span>
              <span className="font-semibold tabular-nums dark:text-gray-100">
                {d.hits}/{d.total}
                <span className="text-xs text-gray-400 ml-1 dark:text-gray-400">
                  ({((d.hits / d.total) * 100).toFixed(0)}%)
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 「翌日 →」。当日はまだ結果が揃っていないため、閲覧できるのは前日まで。 */
export function NextDayLink({ nextDate, renderedToday }: { nextDate: string; renderedToday: string }) {
  const latestDate = addDaysToDateStr(useJstToday(renderedToday), -1);
  return nextDate <= latestDate ? (
    <Link
      href={`/history/${nextDate}`}
      prefetch={false}
      className="text-sm text-[#0d5c3f] px-2 py-1 -mr-2 dark:text-emerald-400"
    >
      翌日 →
    </Link>
  ) : (
    <span className="text-sm text-gray-300 px-2 py-1 -mr-2 dark:text-gray-400">翌日 →</span>
  );
}

/**
 * 表示中の日付が端末の日付から見て正しいかを確かめ、ずれていれば正しいURLへ置き換える。
 *   - /history（既定＝前日）: 日付をまたいで前日分のHTMLが残っていた場合、または旧形式の
 *     /history?date=YYYYMMDD で来た場合
 *   - /history/[date]: まだ結果の揃っていない今日以降の日付が指定された場合（以前と同じく前日へ）
 */
export function HistoryDateGuard({
  viewDate,
  isDefaultView,
}: {
  viewDate: string;
  isDefaultView: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("date") ?? undefined;
  useEffect(() => {
    // 描画後（useEffect内）なので端末の時刻をそのまま使ってよい
    const latestDate = addDaysToDateStr(todayJstStr(), -1);
    if (isDefaultView) {
      if (isValidDateStr(requested) && requested <= latestDate) {
        if (requested !== viewDate) router.replace(`/history/${requested}`);
      } else if (viewDate !== latestDate) {
        router.replace(`/history/${latestDate}`);
      }
    } else if (viewDate > latestDate) {
      router.replace("/history");
    }
  }, [isDefaultView, requested, router, viewDate]);
  return null;
}
