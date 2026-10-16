import { notFound } from "next/navigation";
import { HistoryView } from "../../../components/HistoryView";
import { isValidDateStr, todayJstStr } from "../../../lib/date";

// 日付ごとの予想履歴。初回表示時に生成してCDNにキャッシュする（ISR）。
export function generateStaticParams(): { date: string }[] {
  return [];
}

export default async function HistoryDatePage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isValidDateStr(date)) notFound();
  return <HistoryView viewDate={date} renderedToday={todayJstStr()} isDefaultView={false} />;
}
