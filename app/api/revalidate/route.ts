/**
 * データ同期ジョブ（GitHub Actions）から呼ぶキャッシュ失効エンドポイント。
 *   POST /api/revalidate
 *   Authorization: Bearer <REVALIDATE_SECRET>
 *   {"tags": ["races", "results", "picks"]}
 * 指定タグの画面用キャッシュ（lib/cache.ts）を即時失効させる。stale-while-revalidate
 * （profile="max"）だと更新直後の最初の表示に古いデータが出るため expire: 0 を使う。
 */
import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { ALL_CACHE_TAGS, type CacheTag } from "../../../lib/cache";

function authorized(header: string | null): boolean {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { tags?: unknown };
  const requested = Array.isArray(body.tags) ? body.tags : [];
  const tags = requested.filter((t): t is CacheTag => ALL_CACHE_TAGS.includes(t as CacheTag));
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ revalidated: tags });
}
