import { redirect } from "next/navigation";

// 2026-09、出走表（旧 /races/[id]）と買い目提案（旧ここ）を1画面に統合した
// （Claude Designのモックアップ「競輪予想 UI改善」に合わせたUI刷新）。
// 外部リンク・ブックマーク経由でこのURLに来た場合のために統合後のページへ流す。
// 転送先はIDだけで決まるので、初回に生成した転送をキャッシュして関数を起動せずに返す。
export function generateStaticParams(): { id: string }[] {
  return [];
}

export default async function RaceBetsRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/races/${id}`);
}
