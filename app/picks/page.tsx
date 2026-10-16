import { PicksView } from "../../components/PicksView";
import { todayJstStr } from "../../lib/date";

// 当日の厳選レース。ISR（app/page.tsxと同じ理由・同じ秒数）。日付指定は /picks/[date]。
export const revalidate = 600;

export default function PicksPage() {
  const today = todayJstStr();
  return <PicksView viewDate={today} renderToday={today} legacyDateBase="/picks/" />;
}
