import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 開催場（jocd）ごとの緯度経度をOpen-Meteoのジオコーディング無料APIで取得し、
 * scripts/data/venue_coords.json にキャッシュする。風データ取得（fetch-venue-weather.ts）
 * の前段。DBの開催場名の表記ゆれ（"西武園"/"西武園競輪場"等）はキー正規化で吸収する。
 */

const VENUES: { jocd: string; name: string; query: string }[] = [
  { jocd: "11", name: "函館", query: "函館市" },
  { jocd: "12", name: "青森", query: "青森市" },
  { jocd: "13", name: "いわき平", query: "いわき市" },
  { jocd: "21", name: "弥彦", query: "弥彦" },
  { jocd: "22", name: "前橋", query: "前橋市" },
  { jocd: "23", name: "取手", query: "取手" },
  { jocd: "24", name: "宇都宮", query: "宇都宮市" },
  { jocd: "25", name: "大宮", query: "Omiya, Saitama" },
  { jocd: "26", name: "西武園", query: "所沢市" },
  { jocd: "27", name: "京王閣", query: "Chofu, Tokyo" },
  { jocd: "28", name: "立川", query: "立川" },
  { jocd: "31", name: "松戸", query: "松戸市" },
  { jocd: "34", name: "川崎", query: "川崎市" },
  { jocd: "35", name: "平塚", query: "平塚市" },
  { jocd: "36", name: "小田原", query: "小田原市" },
  { jocd: "37", name: "伊東", query: "伊東市" },
  { jocd: "38", name: "静岡", query: "静岡市" },
  { jocd: "42", name: "名古屋", query: "名古屋市" },
  { jocd: "43", name: "岐阜", query: "岐阜" },
  { jocd: "44", name: "大垣", query: "大垣市" },
  { jocd: "45", name: "豊橋", query: "豊橋市" },
  { jocd: "46", name: "富山", query: "Toyama, Toyama" },
  { jocd: "47", name: "松阪", query: "Matsusaka, Mie" },
  { jocd: "48", name: "四日市", query: "四日市市" },
  { jocd: "53", name: "奈良", query: "奈良市" },
  { jocd: "55", name: "和歌山", query: "和歌山市" },
  { jocd: "56", name: "岸和田", query: "岸和田市" },
  { jocd: "61", name: "玉野", query: "玉野市" },
  { jocd: "62", name: "広島", query: "広島市" },
  { jocd: "63", name: "防府", query: "防府市" },
  { jocd: "73", name: "小松島", query: "Komatsushima, Tokushima" },
  { jocd: "74", name: "高知", query: "Kochi, Kochi" },
  { jocd: "75", name: "松山", query: "松山市" },
  { jocd: "81", name: "小倉", query: "北九州市" },
  { jocd: "83", name: "久留米", query: "久留米市" },
  { jocd: "84", name: "武雄", query: "武雄市" },
  { jocd: "85", name: "佐世保", query: "佐世保市" },
  { jocd: "86", name: "別府", query: "別府市" },
  { jocd: "87", name: "熊本", query: "熊本市" },
];

interface GeocodeResult {
  jocd: string;
  name: string;
  lat: number;
  lon: number;
}

async function geocode(query: string): Promise<{ lat: number; lon: number } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    query
  )}&count=1&language=ja&country=JP&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: { latitude: number; longitude: number }[] };
  const first = json.results?.[0];
  if (!first) return null;
  return { lat: first.latitude, lon: first.longitude };
}

async function main() {
  const out: GeocodeResult[] = [];
  for (const v of VENUES) {
    const coords = await geocode(v.query);
    if (!coords) {
      console.log(`  [失敗] ${v.name}(${v.jocd}) query="${v.query}"`);
      continue;
    }
    console.log(`  ${v.name}(${v.jocd}): ${coords.lat}, ${coords.lon}`);
    out.push({ jocd: v.jocd, name: v.name, lat: coords.lat, lon: coords.lon });
    await new Promise((r) => setTimeout(r, 300)); // 節度あるアクセス間隔
  }
  const outPath = path.join(process.cwd(), "scripts", "data", "venue_coords.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`\n${out.length}/${VENUES.length}件を ${outPath} に保存しました。`);
}

main();
