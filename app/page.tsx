import { HomeView } from "../components/HomeView";
import { todayJstStr } from "../lib/date";

// 当日のホーム。以前はforce-dynamicで表示のたびに米国東部で描画・DB問い合わせしていたが、
// ISR（CDNにキャッシュ）にした。データの更新はGitHub Actionsの同期後のタグ失効
// （lib/cache.ts）で反映され、この秒数はタグ失効が届かなかった時の保険と、日付が
// 変わった後に描画し直すまでの上限（lib/cache.tsのSAFETY_TTL_SECと同じ値）。
// 前日・翌日タブは /day/[date]（searchParamsを読むとキャッシュできないためパスに移した）。
export const revalidate = 600;

export default function Home() {
  const today = todayJstStr();
  return <HomeView viewDate={today} renderToday={today} legacyDateBase="/day/" />;
}
