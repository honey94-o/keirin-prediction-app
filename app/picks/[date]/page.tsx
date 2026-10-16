import { notFound } from "next/navigation";
import { PicksView } from "../../../components/PicksView";
import { isValidDateStr, todayJstStr } from "../../../lib/date";

// 日付指定の厳選レース（旧 /picks?date=YYYYMMDD）。初回アクセス時に描画してCDNにキャッシュする。
export const revalidate = 600;

export function generateStaticParams(): { date: string }[] {
  return [];
}

export default async function DatedPicksPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isValidDateStr(date)) notFound();
  return <PicksView viewDate={date} renderToday={todayJstStr()} />;
}
