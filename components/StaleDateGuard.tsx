"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isValidDateStr, todayJstStr } from "../lib/date";

/**
 * 「当日」「本日の出走」等の日付で変わる表示は、ISRでキャッシュしたページを描画した日
 * （renderedToday）で決まっている。日付をまたいで古い描画が配信された時（深夜0時直後や、
 * しばらく見ていなかった後の最初の表示）は、ブラウザの日付と比べて描画を取り直す。
 * 取り直しても古いまま（ISRの再生成待ち）なら、datedBaseがあれば日付付きURLへ移る。
 *
 * datedBaseを渡したページでは、旧URL（?date=YYYYMMDD。searchParamsを読むとCDNに
 * キャッシュできないため日付付きURLに移した）も日付付きURLへ置き換える。
 */
export function StaleDateGuard({ renderedToday, datedBase }: { renderedToday: string; datedBase?: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!datedBase) return;
    const legacyDate = new URLSearchParams(window.location.search).get("date");
    if (isValidDateStr(legacyDate ?? undefined) && legacyDate !== todayJstStr()) {
      router.replace(`${datedBase}${legacyDate}`);
    }
  }, [datedBase, router]);

  useEffect(() => {
    if (todayJstStr() === renderedToday) return;
    router.refresh();
    const timer = setTimeout(() => {
      if (datedBase) router.replace(`${datedBase}${todayJstStr()}`);
      else router.refresh();
    }, 3000);
    return () => clearTimeout(timer);
  }, [renderedToday, datedBase, router]);

  return null;
}
