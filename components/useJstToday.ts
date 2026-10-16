import { useSyncExternalStore } from "react";
import { todayJstStr } from "../lib/date";

const subscribeNothing = () => () => {};

/**
 * 端末の現在時刻でのJSTの今日（YYYYMMDD）。
 * キャッシュ済みのHTMLは生成した日の日付で描かれているため、ハイドレーション中は
 * サーバーが描いた日付（renderedToday）を返して表示を一致させ、その直後に端末の
 * 日付で描き直す（日付をまたいで古いHTMLが返った場合だけ表示が変わる）。
 */
export function useJstToday(renderedToday: string): string {
  return useSyncExternalStore(subscribeNothing, todayJstStr, () => renderedToday);
}
