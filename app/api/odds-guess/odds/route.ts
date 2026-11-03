/**
 * オッズ逆算ページ用：1レース分の全券種オッズ。
 *   GET /api/odds-guess/odds?slug=hofu&cupId=2026103163&index=4&race=11
 * WINTICKETのオッズページを1回取得するだけで、DBは読まない・保存もしない。
 * 取得先URLはパラメータの形式を厳密に確かめてから組み立てる（任意URLを叩かせない）。
 */
import { fetchRaceOdds } from "../../../../lib/odds-guess/winticket";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("slug") ?? "";
  const cupId = params.get("cupId") ?? "";
  const index = params.get("index") ?? "";
  const race = params.get("race") ?? "";
  if (!/^[a-z]{2,20}$/.test(slug) || !/^\d{10}$/.test(cupId) || !/^\d{1,2}$/.test(index) || !/^\d{1,2}$/.test(race)) {
    return Response.json({ error: "パラメータが不正です" }, { status: 400 });
  }
  try {
    const odds = await fetchRaceOdds(slug, cupId, Number(index), Number(race));
    if (!odds) return Response.json({ error: "このレースは見つかりませんでした" }, { status: 404 });
    return Response.json({ odds }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "取得に失敗しました" }, { status: 502 });
  }
}
