"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", icon: "◉", label: "ホーム" },
  { href: "/picks", icon: "◈", label: "厳選" },
  { href: "/history", icon: "≡", label: "履歴" },
  { href: "/settings", icon: "⚙", label: "設定" },
] as const;

/** 現在地の判定。/racesや/racers/venues配下は「ホーム」の続き扱いにする。 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/races") || pathname.startsWith("/venues") || pathname.startsWith("/favorites");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Claude Designのモックアップ（競輪予想 UI改善.dc.html）で追加された下部固定タブ。
 * 旧Header（上部の緑ヘッダー、履歴/設定リンクのみ）を置き換える形でapp/layout.tsxに
 * 常設し、全ページから厳選(/picks)へも直接飛べるようにする。
 */
export function BottomTabBar() {
  const pathname = usePathname();
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-20 grid grid-cols-4 bg-ink-1/90 backdrop-blur border-t border-white/[.06] pt-2 px-2"
      style={{ paddingBottom: "max(0.45rem, env(safe-area-inset-bottom))" }}
    >
      {TABS.map((tab) => {
        const active = isActive(pathname, tab.href);
        const color = active ? "text-mint" : "text-mist-5";
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="flex flex-col items-center gap-1 py-1.5"
          >
            <span className={`text-[15px] ${color}`}>{tab.icon}</span>
            <span className={`text-[10px] font-bold ${color}`}>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
