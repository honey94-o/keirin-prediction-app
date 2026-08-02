import Link from "next/link";

export function Header() {
  return (
    <header className="sticky top-0 z-10 bg-[#0d5c3f] text-white px-4 py-3 shadow-sm flex items-center justify-between">
      <Link href="/" className="text-lg font-bold">
        競輪予想
      </Link>
      <nav className="flex gap-4 text-sm">
        <Link href="/history">履歴</Link>
        <Link href="/settings">設定</Link>
      </nav>
    </header>
  );
}
