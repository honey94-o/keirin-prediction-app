/**
 * オッズ逆算ページ用：当日・翌日に開催がある場の一覧。
 *   GET /api/odds-guess/venues
 * WINTICKETの競輪トップを1回取得するだけで、DBは読まない。開催の並びは数分では
 * 変わらないので、CDNに5分キャッシュさせてWINTICKETへの取得を減らす。
 */
import { fetchVenueOptions } from "../../../../lib/odds-guess/winticket";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const venues = await fetchVenueOptions();
    return Response.json(
      { venues },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "取得に失敗しました" }, { status: 502 });
  }
}
