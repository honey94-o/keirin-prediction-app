import type { Metadata } from "next";
import { OddsGuessClient } from "./OddsGuessClient";

export const metadata: Metadata = {
  title: "オッズ逆算 | 競輪予想",
};

/**
 * オッズ逆算ページ。予想家の「購入金額・点数・最高想定払戻」から、今のオッズ表と
 * 照らし合わせて買い目の当たりをつける。既存の予想ロジック・DBには一切触れず、
 * オッズは画面からの操作時にだけ /api/odds-guess/* 経由でWINTICKETから取得する。
 */
export default function OddsGuessPage() {
  return <OddsGuessClient />;
}
