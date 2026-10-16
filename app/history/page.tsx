import { HistoryView } from "../../components/HistoryView";
import { todayJstStr, addDaysToDateStr } from "../../lib/date";

// 静的生成してCDNから返す（データはlib/queries/history.tsのタグ付きキャッシュ。結果同期・
// 予想記録の失効で作り直される）。以前は ?date= で日付を切り替えていたが、クエリ文字列を
// 読むとページ全体が毎回の動的描画になるため、日付指定は /history/[date] に分けた
// （旧URLはクライアント側で /history/[date] へ置き換える）。
//
// ここで表示するのは生成時点の前日（当日はまだ結果が揃っていないため、閲覧可能な最新日は
// 前日まで）。日付をまたいで古いHTMLが返った場合はHistoryDateGuardが正しい日へ移す。
export default function HistoryPage() {
  const today = todayJstStr();
  return <HistoryView viewDate={addDaysToDateStr(today, -1)} renderedToday={today} isDefaultView />;
}
