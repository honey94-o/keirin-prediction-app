import { notFound } from "next/navigation";
import { HomeView } from "../../../components/HomeView";
import { isValidDateStr, todayJstStr } from "../../../lib/date";

// 前日・翌日タブ（旧 /?date=YYYYMMDD）。日付をパスに持たせ、初回アクセス時に描画して
// CDNにキャッシュする（オンデマンドISR。ビルド時には生成しない）。更新はapp/page.tsxと同じ。
export const revalidate = 600;

export function generateStaticParams(): { date: string }[] {
  return [];
}

export default async function DayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isValidDateStr(date)) notFound();
  return <HomeView viewDate={date} renderToday={todayJstStr()} />;
}
