import { BET_TYPES, type BetType, type OddsEntry, type RaceOdds, type VenueOption } from "./types";

/**
 * オッズ逆算ページ用のWINTICKET取得。ページに埋め込まれたReact Queryのキャッシュ
 * (window.__PRELOADED_STATE__) を読む（scraper/winticket_scraper.py と同じ方式）。
 * 取得は利用者が画面で操作した時だけで、DBへの保存もしない。
 * robots.txtで禁止されているのは /keirin/cups/ のみで、トップ・オッズページは対象外。
 */

const BASE = "https://www.winticket.jp";
const STATE_MARKER = "window.__PRELOADED_STATE__ = ";
const USER_AGENT = "Mozilla/5.0 (compatible; keirin-prediction-app odds-guess)";

/** markerの直後から始まるJSONオブジェクトの終端を、文字列リテラルを考慮して探す。 */
function extractJsonObject(html: string, start: number): string | null {
  if (html[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

type Query = { queryKey?: unknown; state?: { data?: unknown } };

/** ページを取得し、React Queryのキャッシュを「クエリ名 → data」の形で返す。404ならnull。 */
async function fetchQueries(path: string): Promise<Map<string, Record<string, unknown>> | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WINTICKET ${res.status}`);
  const html = await res.text();
  const idx = html.indexOf(STATE_MARKER);
  if (idx < 0) throw new Error("WINTICKETのページ形式が変わった可能性があります（stateなし）");
  const json = extractJsonObject(html, idx + STATE_MARKER.length);
  if (!json) throw new Error("WINTICKETのページ形式が変わった可能性があります（JSON終端なし）");
  const state = JSON.parse(json) as { tanStackQuery?: { queries?: Query[] } };
  const map = new Map<string, Record<string, unknown>>();
  for (const q of state.tanStackQuery?.queries ?? []) {
    const name = Array.isArray(q.queryKey) ? q.queryKey[1] : null;
    const data = q.state?.data;
    if (typeof name === "string" && data && typeof data === "object") {
      map.set(name, data as Record<string, unknown>);
    }
  }
  return map;
}

type WtVenue = { id: string; name: string; slug: string };
type WtCup = { id: string; name: string; venueId: string };
type WtSchedule = { id: string; cupId: string; date: string; index: number };

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 当日・翌日に開催がある場の一覧（WINTICKET競輪トップ1回の取得）。 */
export async function fetchVenueOptions(): Promise<VenueOption[]> {
  const queries = await fetchQueries("/keirin");
  const top = queries?.get("FETCH_KEIRIN_TOP_COMMON");
  if (!top) throw new Error("WINTICKETトップの開催情報が読めませんでした");
  const venueList = queries?.get("FETCH_KEIRIN_VENUE_LIST");
  const venues = new Map<string, WtVenue>();
  for (const v of [...asArray<WtVenue>(venueList?.venues), ...asArray<WtVenue>(top.venues)]) {
    if (v.slug) venues.set(v.id, v);
  }
  const cups = new Map(asArray<WtCup>(top.cups).map((c) => [c.id, c]));
  // today[].raceId は「レース番号2桁 + 場コード2桁 + YYYYMMDD」。その場で今いちばん近いレース。
  const currentRace = new Map<string, number>();
  for (const t of asArray<{ scheduleId: string; raceId: string }>(top.today)) {
    const n = Number(t.raceId?.slice(0, 2));
    if (n > 0) currentRace.set(t.scheduleId, n);
  }
  const today = todayJst();
  const options: VenueOption[] = [];
  for (const s of asArray<WtSchedule>(top.schedules)) {
    if (s.date < today) continue;
    const cup = cups.get(s.cupId);
    const venue = cup ? venues.get(cup.venueId) : undefined;
    if (!cup || !venue) continue;
    options.push({
      date: s.date,
      venueId: venue.id,
      venueName: venue.name,
      slug: venue.slug,
      cupId: s.cupId,
      index: s.index,
      cupName: cup.name,
      currentRace: currentRace.get(s.id) ?? null,
    });
  }
  options.sort((a, b) => a.date.localeCompare(b.date) || a.venueId.localeCompare(b.venueId));
  return options;
}

type WtOdds = { key: number[]; odds: number; popularityOrder: number; absent: boolean };

/** 1レース分の全券種オッズ（WINTICKETオッズページ1回の取得）。レースが無ければnull。 */
export async function fetchRaceOdds(slug: string, cupId: string, index: number, raceNo: number): Promise<RaceOdds | null> {
  const queries = await fetchQueries(`/keirin/${slug}/odds/${cupId}/${index}/${raceNo}`);
  if (!queries) return null;
  const common = queries.get("FETCH_KEIRIN_RACE");
  const oddsData = queries.get("FETCH_KEIRIN_RACE_ODDS");
  if (!common || !oddsData) return null;

  const race = common.race as Record<string, unknown> | undefined;
  if (!race) return null;
  const schedule = common.schedule as { cupId?: string; date?: string } | undefined;
  const cup = asArray<WtCup>(common.cups).find((c) => c.id === schedule?.cupId);
  const venue = asArray<WtVenue>(common.venues).find((v) => v.id === cup?.venueId);
  const players = new Map(asArray<{ id: string; name: string }>(common.players).map((p) => [p.id, p.name]));
  const entries = asArray<{ number: number; playerId: string; absent: boolean }>(common.entries)
    .map((e) => ({ number: e.number, name: players.get(e.playerId) ?? "", absent: Boolean(e.absent) }))
    .sort((a, b) => a.number - b.number);

  const linePrediction = common.linePrediction as
    | { lineType?: string; lines?: { entries?: { numbers?: number[] }[] }[] }
    | undefined;
  const lines = (linePrediction?.lines ?? [])
    .map((line) => (line.entries ?? []).flatMap((e) => e.numbers ?? []))
    .filter((line) => line.length > 0);

  const odds = {} as Record<BetType, OddsEntry[]>;
  for (const betType of BET_TYPES) {
    odds[betType] = asArray<WtOdds>(oddsData[betType])
      .filter((o) => !o.absent && o.odds > 0 && Array.isArray(o.key))
      .map((o) => ({ key: o.key, odds: o.odds, popularity: o.popularityOrder }));
  }

  return {
    venueName: venue?.name ?? "",
    cupName: cup?.name ?? "",
    date: schedule?.date ?? "",
    race: {
      number: Number(race.number),
      className: String(race.class ?? ""),
      raceType: String(race.raceType ?? ""),
      startAt: Number(race.startAt ?? 0),
      closeAt: Number(race.closeAt ?? 0),
      entriesNumber: Number(race.entriesNumber ?? entries.length),
      cancel: Boolean(race.cancel),
    },
    entries,
    lines,
    lineType: linePrediction?.lineType ?? "",
    oddsUpdatedAt: Number(oddsData.oddsUpdatedAt ?? 0),
    finalOdds: Boolean(oddsData.finalOdds),
    odds,
  };
}
