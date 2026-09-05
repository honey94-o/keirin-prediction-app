import { parseEncp } from "./date";
import type { RaceRow } from "./types";

/**
 * jocd(開催場コード) → WINTICKETの開催場スラッグ。
 * WINTICKETのAPI/サイトにはjocdからスラッグへの対応表が公開されていないため、
 * scraper/_tmp_discover_venue_jocd.py（日程ページを実際に叩いて確認する使い捨て
 * スクリプト）で調べた実測値。当月・前月に開催が無かった4場（千葉・福井・向日町・
 * 高松）はこのDBでも一度もレースが観測されておらず突き合わせできなかったため、
 * 意図的に含めていない（該当jocdはリンク非表示にフォールバックする）。
 */
export const JOCD_TO_WINTICKET_SLUG: Record<string, string> = {
  "11": "hakodate",
  "12": "aomori",
  "13": "iwakidaira",
  "21": "yahiko",
  "22": "maebashi",
  "23": "toride",
  "24": "utsunomiya",
  "25": "omiya",
  "26": "seibuen",
  "27": "keiokaku",
  "28": "tachikawa",
  "31": "matsudo",
  "34": "kawasaki",
  "35": "hiratsuka",
  "36": "odawara",
  "37": "ito",
  "38": "shizuoka",
  "42": "nagoya",
  "43": "gifu",
  "44": "ogaki",
  "45": "toyohashi",
  "46": "toyama",
  "47": "matsusaka",
  "48": "yokkaichi",
  "53": "nara",
  "55": "wakayama",
  "56": "kishiwada",
  "61": "tamano",
  "62": "hiroshima",
  "63": "hofu",
  "73": "komatsushima",
  "74": "kochi",
  "75": "matsuyama",
  "81": "kokura",
  "83": "kurume",
  "84": "takeo",
  "85": "sasebo",
  "86": "beppu",
  "87": "kumamoto",
};

/**
 * WINTICKETのレース結果ページ（決まり手・映像へのリンクがある）のURLを組み立てる。
 * スラッグが未判明の開催場（JOCD_TO_WINTICKET_SLUG参照）やencpが無い/形式不明な
 * レースではnullを返す。
 */
export function buildWinticketResultUrl(race: RaceRow): string | null {
  const slug = JOCD_TO_WINTICKET_SLUG[race.jocd];
  if (!slug) return null;
  const parsed = parseEncp(race.encp);
  if (!parsed) return null;
  return `https://winticket.jp/keirin/${slug}/raceresult/${parsed.cupId}/${parsed.day}/${parsed.raceNo}`;
}
