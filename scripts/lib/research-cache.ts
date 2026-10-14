/**
 * 2・3着研究（2026-10）用の共通ヘルパー。scripts/local-db/build-scored-cache.tsが
 * 作ったscored-cache.json（本番と同一のpredictRaceを全確定レースで実行した結果）を読み、
 * 厳選・バリカタの「実際の選定条件」を本番（scripts/compute-picks.ts +
 * lib/repository.tsのgetDailyPicks）と同じ形で再現する。各検証スクリプトは
 * これを共有し、選定条件・train/test分割・回収率の計算方法を揃える。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { raceStage } from "../../lib/scoring";

export interface CEntry {
  car: number;
  snum: string;
  totalScore: number;
  lineScore: number;
  kyakuScore: number;
  statsScore: number;
  lineGroup: number | null;
  linePos: string | null;
  kyaku: string | null;
  tokuten: number | null;
  classRank: string | null;
  nige: number | null;
  makuri: number | null;
  sashi: number | null;
  mark: number | null;
  standing: number | null;
  backLead: number | null;
  homeLead: number | null;
  syouritu: number | null;
  ren2: number | null;
  ren3: number | null;
  gear: number | null;
  finish: number | null;
  kimarite: string | null;
}

export interface CRace {
  raceId: number;
  date: string;
  jocd: string;
  venue: string;
  raceNo: number;
  grade: string | null;
  syumoku: string | null;
  startTime: string | null;
  girls: boolean;
  margin: number;
  /** totalScore降順。entries[0]が◎ */
  entries: CEntry[];
  /** buildLineAwarePool(◎, ◎のline_group)。現行の2・3着候補の並び */
  honmeiPool: number[];
  scenarios: { label: string; axis: number; combos: string[] }[];
  actual: string;
  deadHeat: boolean;
  /** 実際の3連単組の払戻（100円あたり、円）。oddsが無いレースはnull */
  payout: number | null;
  payoutNinki: number | null;
  hasOdds: boolean;
}

export const CACHE_PATH = path.join(process.cwd(), "scripts", "data", "scored-cache.json");

export function loadCache(): CRace[] {
  return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CRace[];
}

export const DAILY_PICKS_MIN_MARGIN = 10;
export const DAILY_PICKS_LIMIT = 10;
export const ABILITY_GAP_THIN_THRESHOLD = 5;
export const BARIKATA_MIN_MARGIN = 8;

/** compute-picks.tsの厳選候補条件（予選・9車除外、ability-gap除外）＋margin>=10。 */
export function isGensenCandidate(r: CRace): boolean {
  if (raceStage(r.syumoku) === "予選") return false;
  if (r.entries.length < 2 || r.entries.length === 9) return false;
  if (r.margin < DAILY_PICKS_MIN_MARGIN) return false;
  const honmei = r.entries[0];
  const others = r.entries.slice(1);
  if (honmei.tokuten != null && others.every((o) => o.tokuten != null)) {
    let closest = others[0];
    for (const o of others) if (o.tokuten! > closest.tokuten!) closest = o;
    const gap = honmei.tokuten - closest.tokuten!;
    if (gap < ABILITY_GAP_THIN_THRESHOLD && (closest.kyaku === "逃" || closest.kyaku === "両")) return false;
  }
  return true;
}

/** getDailyPicks相当：日ごとにmargin降順で上位10件。 */
export function selectGensen(races: CRace[], candidate = isGensenCandidate): CRace[] {
  const byDate = new Map<string, CRace[]>();
  for (const r of races) {
    if (!candidate(r)) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const out: CRace[] = [];
  for (const arr of byDate.values()) {
    out.push(...arr.sort((a, b) => b.margin - a.margin).slice(0, DAILY_PICKS_LIMIT));
  }
  return out.sort((a, b) => (a.date === b.date ? a.raceId - b.raceId : a.date.localeCompare(b.date)));
}

/** compute-picks.tsのバリカタ条件：margin>=8・予想1-2-3位が同ライン・9車除外。 */
export function isBarikataCandidate(r: CRace): boolean {
  if (r.entries.length < 3 || r.entries.length === 9) return false;
  if (r.margin < BARIKATA_MIN_MARGIN) return false;
  const [a, b, c] = r.entries;
  return a.lineGroup != null && a.lineGroup === b.lineGroup && b.lineGroup === c.lineGroup;
}

/** 現行のバリカタ1点（orderBarikataSecondThirdと同じ隊列順補正）。 */
const LINE_POSITION_RANK: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4 };
export function currentBarikataCombo(r: CRace): string {
  const [h, s, t] = r.entries;
  const rs = LINE_POSITION_RANK[s.linePos ?? ""] ?? 99;
  const rt = LINE_POSITION_RANK[t.linePos ?? ""] ?? 99;
  const [second, third] = rt < rs ? [t, s] : [s, t];
  return `${h.car}-${second.car}-${third.car}`;
}

export function honmeiCombos(r: CRace): string[] {
  return r.scenarios.find((s) => s.label === "本命")?.combos ?? [];
}

/** 日付で前2/3をtrain、後1/3をtestに分ける境界日（そのレース集合の開催日ベース）。 */
export function splitDate(races: CRace[]): string {
  const dates = [...new Set(races.map((r) => r.date))].sort();
  return dates[Math.floor(dates.length * (2 / 3))];
}

export interface Stats {
  races: number;
  points: number;
  hits: number;
  stake: number;
  payout: number;
  hitRate: number;
  roi: number;
  /** 最大払戻1件を除いた回収率（外れ値依存のチェック用） */
  roiExTop1: number;
}

/**
 * formationFnが返す組み合わせ（空配列＝見送り）を100円ずつ買った場合の成績。
 * oddsが無いレース（払戻不明）は的中しても金額が分からないため母数から除く。
 */
export function evaluate(races: CRace[], formationFn: (r: CRace) => string[]): Stats {
  let n = 0;
  let points = 0;
  let hits = 0;
  let payout = 0;
  let maxHit = 0;
  for (const r of races) {
    if (!r.hasOdds) continue;
    const combos = formationFn(r);
    if (combos.length === 0) continue;
    n++;
    points += combos.length;
    if (combos.includes(r.actual) && r.payout != null) {
      hits++;
      payout += r.payout;
      maxHit = Math.max(maxHit, r.payout);
    }
  }
  const stake = points * 100;
  return {
    races: n,
    points,
    hits,
    stake,
    payout,
    hitRate: n ? hits / n : 0,
    roi: stake ? payout / stake : 0,
    roiExTop1: stake ? (payout - maxHit) / stake : 0,
  };
}

export function fmt(s: Stats): string {
  return (
    `n=${s.races} 点数${(s.points / Math.max(1, s.races)).toFixed(1)} 的中${(s.hitRate * 100).toFixed(1)}%` +
    ` 回収${(s.roi * 100).toFixed(1)}% (最大1件除外${(s.roiExTop1 * 100).toFixed(1)}%) 収支${(s.payout - s.stake).toLocaleString()}円`
  );
}

/** 全期間・train・testの3行をまとめて出す。 */
export function reportSplit(label: string, races: CRace[], formationFn: (r: CRace) => string[], cut?: string) {
  const boundary = cut ?? splitDate(races);
  const train = races.filter((r) => r.date < boundary);
  const test = races.filter((r) => r.date >= boundary);
  console.log(`[${label}]`);
  console.log(`  全体 ${fmt(evaluate(races, formationFn))}`);
  console.log(`  train(<${boundary}) ${fmt(evaluate(train, formationFn))}`);
  console.log(`  test (>=${boundary}) ${fmt(evaluate(test, formationFn))}`);
}
