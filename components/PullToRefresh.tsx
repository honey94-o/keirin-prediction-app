"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

// PWAとしてホーム画面に追加した状態（standalone）だとブラウザのUIが無く、
// iOS Safari標準のスワイプで引っ張って更新も使えないため、自前で実装する。
// ページ最上部にいる時だけ、下に引っ張って離すと router.refresh()
// （サーバーコンポーネントを再実行し最新データを反映、ページ開き直しと同じ効果）
// を呼ぶ。ネイティブのtouchイベントリスナーを使うのは、Reactの合成イベント経由だと
// ブラウザやReactのバージョンによってpreventDefault()が効かないことがあるため。
const PULL_THRESHOLD = 64;
const MAX_PULL = 100;
const RESISTANCE = 0.5;

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);

  useEffect(() => {
    if (refreshing && !isPending) {
      setRefreshing(false);
    }
  }, [refreshing, isPending]);

  const triggerRefresh = useCallback(() => {
    setRefreshing(true);
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY === 0) {
        startY.current = e.touches[0].clientY;
        pulling.current = true;
      } else {
        startY.current = null;
        pulling.current = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current || startY.current == null || window.scrollY > 0) {
        return;
      }
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPullDistance(0);
        return;
      }
      e.preventDefault();
      setPullDistance(Math.min(delta * RESISTANCE, MAX_PULL));
    };

    const onTouchEnd = () => {
      if (pulling.current && pullDistance >= PULL_THRESHOLD) {
        triggerRefresh();
      }
      setPullDistance(0);
      pulling.current = false;
      startY.current = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
    // pullDistanceはonTouchEndの判定に必要だが、リスナー自体は初回のみ登録すれば
    // 十分なのでrefで持たせず依存配列にも含めない（毎touchmoveで張り直すと重い）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerRefresh]);

  const showSpinner = refreshing || pullDistance > 0;
  const indicatorProgress = Math.min(pullDistance / PULL_THRESHOLD, 1);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
      <div
        className="flex items-center justify-center overflow-hidden shrink-0"
        style={{
          height: refreshing ? 40 : pullDistance,
          transition: pulling.current ? "none" : "height 0.2s ease-out",
        }}
        aria-hidden={!showSpinner}
      >
        {showSpinner && (
          <div
            className="w-5 h-5 rounded-full border-2 border-[#0d5c3f] border-t-transparent"
            style={{
              opacity: refreshing ? 1 : indicatorProgress,
              transform: refreshing ? undefined : `rotate(${indicatorProgress * 360}deg)`,
              animation: refreshing ? "ptr-spin 0.6s linear infinite" : undefined,
            }}
          />
        )}
      </div>
      {children}
      <style>{`
        @keyframes ptr-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
