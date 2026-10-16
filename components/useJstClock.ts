import { useSyncExternalStore } from "react";
import { nowJstHHMM, todayJstStr } from "../lib/date";

// 時計の変化は購読しない（以前のサーバー描画と同じく、ページを開いた時点の値で表示する）。
const subscribeNever = () => () => {};

/**
 * ブラウザの時計でのJSTの日付（YYYYMMDD）。ISRでキャッシュしたHTMLは描画した時点の
 * 日時のままなので、日時で変わる表示はブラウザで計算し直す。サーバー描画とハイドレーション
 * ではserverValue（nullなら「まだ分からない」）を使い、ハイドレーション直後に実際の値で
 * 描画し直す（useSyncExternalStoreのgetServerSnapshotの仕組み）。
 */
export function useJstToday<T extends string | null>(serverValue: T): string | T {
  return useSyncExternalStore<string | T>(subscribeNever, todayJstStr, () => serverValue);
}

/** ブラウザの時計でのJSTの"HH:MM"。useJstTodayと同じ扱い。 */
export function useJstNowHHMM<T extends string | null>(serverValue: T): string | T {
  return useSyncExternalStore<string | T>(subscribeNever, nowJstHHMM, () => serverValue);
}
