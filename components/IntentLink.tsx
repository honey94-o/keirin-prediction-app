"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

/**
 * 触れた（タップし始めた・マウスを載せた）時だけ先読みするリンク。
 * レース・開催場ページはエッジにキャッシュされ、結果同期（15分おき）のたびに失効する。
 * 一覧の全リンクを既定の先読み（画面に入ったら取得）にすると、見ていないレースまで
 * 失効のたびに生成し直すことになり、Neonの転送量（無料枠5GB/月）を無駄に使う。
 */
export function IntentLink({ onTouchStart, onMouseEnter, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
    />
  );
}
