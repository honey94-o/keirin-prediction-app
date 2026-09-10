import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";
import { predictRace } from "../lib/predict";
import {
  getResultsForRace,
  getOddsForRace,
  resolveActualCombo,
  enableReadCache,
} from "../lib/repository";
import { raceStage, buildLineAwarePool, HIGH_CONFIDENCE_MARGIN } from "../lib/scoring";
import type { ScoredEntry } from "../lib/types";

/**
 * ユーザー依頼「厳選の本命買い目、点数が最適で回収率が上がるように点数を検証。
 * 2着3着はデータ上位なだけでなくライン・展開も意識して選ぶ」への回答。
 *
 * 厳選対象（margin>=10・予選以外・9車以外）の本命フォーメーションについて、
 * 2着3着候補プールの並べ方を2通り試し、それぞれ買い目を優先順で1点ずつ
 * 増やしながら累積の的中率・回収率がどこでピークになるかを見る。
 * 実オッズ・実結果で計算。train/test（開催日で2/3分割）で再現も確認する。
 *
 * プール並べ方:
 *   A = 現行 buildLineAwarePool（軸と同ラインを先頭、残りはlineupOrderScore順）
 *   C = ライン束ね（軸の同ライン→隊列順、他ラインはライン単位で束ねて強い順・
 *       ライン内は隊列順、単騎は最後）。スジ違い（他ラインの3番手等）を
 *       後ろに回し、展開どおりに決まる並びを上位に置く。
 */

const MARGIN_MIN = HIGH_CONFIDENCE_MARGIN; // 10
const K_GRID = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];
const LINE_POS_ORDER: Record<string, number> = { 先頭: 0, 番手: 1, "3番手": 2 };

function orderedCombosA(honmeiCar: number, honmeiLine: number | null, scored: ScoredEntry[]): string[] {
  const pool = buildLineAwarePool(honmeiCar, honmeiLine, scored);
  return nestedLoop(honmeiCar, pool);
}

function orderedCombosC(honmeiCar: number, honmeiLine: number | null, scored: ScoredEntry[]): string[] {
  const others = scored.filter((s) => s.entry.car_num !== honmeiCar);
  const posRank = (s: ScoredEntry) => LINE_POS_ORDER[s.entry.line_position ?? ""] ?? 3;

  const ownLine = others
    .filter((s) => honmeiLine != null && s.entry.line_group === honmeiLine)
    .sort((a, b) => posRank(a) - posRank(b));

  const rivalGroups = new Map<number, ScoredEntry[]>();
  const solos: ScoredEntry[] = [];
  for (const s of others) {
    if (honmeiLine != null && s.entry.line_group === honmeiLine) continue;
    if (s.entry.line_group == null) {
      solos.push(s);
      continue;
    }
    const arr = rivalGroups.get(s.entry.line_group) ?? [];
    arr.push(s);
    rivalGroups.set(s.entry.line_group, arr);
  }
  const rivalLinesSorted = [...rivalGroups.values()]
    .map((members) => ({
      members: members.sort((a, b) => posRank(a) - posRank(b)),
      strength: Math.max(...members.map((m) => m.totalScore)),
    }))
    .sort((a, b) => b.strength - a.strength);

  const ordered = [
    ...ownLine,
    ...rivalLinesSorted.flatMap((l) => l.members),
    ...solos.sort((a, b) => b.totalScore - a.totalScore),
  ].map((s) => s.entry.car_num);

  return nestedLoop(honmeiCar, ordered);
}

function nestedLoop(axis: number, pool: number[]): string[] {
  const combos: string[] = [];
  for (const second of pool) {
    for (const third of pool) {
      if (second === third || second === axis || third === axis) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

type Rec = {
  kaisaiDate: string;
  margin: number;
  winnerRankA: number; // 当たり組が並びの何番目か（-1=プール外）
  winnerRankC: number;
  actualOdds: number;
};

async function main() {
  enableReadCache();
  const db = getDb();
  const rowsRes = await db.execute(
    `SELECT DISTINCT r.race_id FROM results r
     JOIN races ra ON ra.id = r.race_id
     WHERE r.finish_pos IS NOT NULL AND ra.encp LIKE 'wt:%'
     ORDER BY r.race_id`
  );
  let raceIds = (rowsRes.rows as unknown as { race_id: number }[]).map((r) => r.race_id);
  const limArg = process.argv.find((a) => a.startsWith("--limit="));
  const lim = limArg ? Number(limArg.split("=")[1]) : null;
  if (lim) raceIds = raceIds.slice(-lim);
  console.log(`候補レース: ${raceIds.length}件（厳選条件で更に絞り込み）`);

  const recs: Rec[] = [];
  const BATCH = 5;
  for (let i = 0; i < raceIds.length; i += BATCH) {
    const chunk = raceIds.slice(i, i + BATCH);
    const out = await Promise.all(
      chunk.map(async (raceId) => {
        const p = await predictRace(raceId);
        if (!p || p.scored.length < 3) return null;
        if (p.scored.length === 9) return null;
        if (raceStage(p.race.syumoku) === "予選") return null;
        const honmei = p.scored[0];
        const taikou = p.scored[1];
        const margin = honmei.totalScore - taikou.totalScore;
        if (margin < MARGIN_MIN) return null;

        const [results, odds] = await Promise.all([
          getResultsForRace(raceId),
          getOddsForRace(raceId),
        ]);
        const actual = resolveActualCombo(results, odds);
        if (!actual) return null;
        const actualOdds =
          odds.find((o) => o.bet_type === "3連単" && o.combination === actual)?.odds_value ?? null;
        if (actualOdds == null) return null;

        const a = orderedCombosA(honmei.entry.car_num, honmei.entry.line_group, p.scored);
        const c = orderedCombosC(honmei.entry.car_num, honmei.entry.line_group, p.scored);
        return {
          kaisaiDate: p.race.kaisai_date,
          margin,
          winnerRankA: a.indexOf(actual),
          winnerRankC: c.indexOf(actual),
          actualOdds,
        } as Rec;
      })
    );
    for (const r of out) if (r) recs.push(r);
    if ((i / BATCH) % 20 === 0) console.log(`  ${Math.min(i + BATCH, raceIds.length)}/${raceIds.length}`);
  }

  console.log(`\n厳選対象レース: ${recs.length}件\n`);

  const dates = [...new Set(recs.map((r) => r.kaisaiDate))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];

  function curve(label: string, rankOf: (r: Rec) => number, subset: Rec[]) {
    console.log(`--- ${label}（n=${subset.length}）---`);
    console.log("  点数  的中率   回収率");
    for (const k of K_GRID) {
      let stake = 0;
      let payout = 0;
      let hits = 0;
      for (const r of subset) {
        stake += 100 * k;
        const rank = rankOf(r);
        if (rank >= 0 && rank < k) {
          hits++;
          payout += 100 * r.actualOdds;
        }
      }
      const roi = (payout / stake) * 100;
      const hr = (hits / subset.length) * 100;
      console.log(`  ${String(k).padStart(3)}   ${hr.toFixed(1).padStart(5)}%  ${roi.toFixed(1).padStart(6)}%`);
    }
  }

  for (const [ord, rankOf] of [
    ["A=現行 line-aware pool", (r: Rec) => r.winnerRankA],
    ["C=ライン束ね", (r: Rec) => r.winnerRankC],
  ] as const) {
    console.log(`\n=== 並べ方 ${ord} ===`);
    curve("全体", rankOf, recs);
    curve("train", rankOf, recs.filter((r) => r.kaisaiDate < split));
    curve("test", rankOf, recs.filter((r) => r.kaisaiDate >= split));
  }

  // margin帯別（並べ方Aのみ）: 帯が上＝より堅い＝配当が低い可能性。帯ごとに
  // 最適点数が違うかを見る。
  console.log(`\n=== margin帯別（並べ方A）===`);
  for (const [lo, hi] of [
    [10, 13],
    [13, 18],
    [18, 999],
  ] as const) {
    curve(`margin ${lo}〜${hi === 999 ? "" : hi}`, (r) => r.winnerRankA, recs.filter((r) => r.margin >= lo && r.margin < hi));
  }

  // 当たり組がプールの何番目に来ているかの分布（並べ方の質）
  const inA = recs.filter((r) => r.winnerRankA >= 0);
  const inC = recs.filter((r) => r.winnerRankC >= 0);
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  console.log(
    `\n当たり組がプール内にある率: A=${((inA.length / recs.length) * 100).toFixed(1)}% C=${((inC.length / recs.length) * 100).toFixed(1)}%`
  );
  console.log(
    `当たり組の順位 中央値: A=${med(inA.map((r) => r.winnerRankA))} C=${med(inC.map((r) => r.winnerRankC))}` +
      `（小さいほど少ない点数で獲れる）`
  );
}

main();
