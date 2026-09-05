"use client";

import { useRouter } from "next/navigation";

/**
 * ブラウザ履歴で1つ前に戻るボタン。選手ページ（/racers/[snum]）は出走表・
 * 買い目提案・お気に入り一覧・設定など複数の画面から遷移してくるため、
 * 固定リンクではなく実際に遷移元へ戻れるようhistory.back()を使う。
 */
export function BackButton({ label = "← 戻る" }: { label?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="text-sm text-[#0d5c3f] mb-2 inline-block dark:text-emerald-400"
    >
      {label}
    </button>
  );
}
