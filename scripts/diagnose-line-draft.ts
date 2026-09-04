import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

/**
 * 「格上の先頭と組む番手/3番手は、格下の先頭と組むより成績が良いのでは」
 * （ドラフト効果・先頭が強いほど自分も上位に残りやすい）という仮説を検証する。
 * class_rankを数値化（CLASS_RANK_SCORESと同じ序列）し、自分の級と自分のラインの
 * 先頭選手の級を比較する。既存の「同質フィールドは最上位が勝つのが定義上100%」
 * というトートロジーの罠（このセッションで一度発生済み）を避けるため、判定対象は
 * 先頭ではなく番手/3番手の成績（先頭本人の勝敗は見ない）にする。
 */

const CLASS_RANK_SCORES: Record<string, number> = {
  SS: 100,
  S1: 85,
  S2: 70,
  A1: 55,
  A2: 40,
  A3: 25,
  L1: 70,
  L2: 45,
  L3: 25,
};

type Row = {
  race_id: number;
  snum: string;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  finish_pos: number;
  class_rank: string | null;
};

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, e.line_position, r.finish_pos,
           rc.class_rank
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY e.race_id
  `);
  const rows = result.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${rows.length}件`);

  const byRaceLine = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.line_group == null) continue;
    const key = `${r.race_id}:${r.line_group}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(r);
    byRaceLine.set(key, arr);
  }

  const buckets = {
    格上先頭: { n: 0, win: 0, top3: 0 },
    同格先頭: { n: 0, win: 0, top3: 0 },
    格下先頭: { n: 0, win: 0, top3: 0 },
  };

  for (const [, members] of byRaceLine) {
    const senko = members.find((m) => m.line_position === "先頭");
    if (!senko || !senko.class_rank) continue;
    const senkoScore = CLASS_RANK_SCORES[senko.class_rank];
    if (senkoScore == null) continue;

    for (const m of members) {
      if (m.line_position !== "番手" && m.line_position !== "3番手") continue;
      if (!m.class_rank) continue;
      const myScore = CLASS_RANK_SCORES[m.class_rank];
      if (myScore == null) continue;

      const bucket =
        senkoScore > myScore ? "格上先頭" : senkoScore < myScore ? "格下先頭" : "同格先頭";
      buckets[bucket].n++;
      if (m.finish_pos === 1) buckets[bucket].win++;
      if (m.finish_pos <= 3) buckets[bucket].top3++;
    }
  }

  console.log("\n■ 自分（番手/3番手）から見た先頭選手の格 別 → 自分自身の成績:");
  for (const label of ["格上先頭", "同格先頭", "格下先頭"] as const) {
    const b = buckets[label];
    console.log(
      `  ${label}: 単勝的中率${((b.win / b.n) * 100).toFixed(1)}% (${b.win}/${b.n}) / ` +
        `複勝率${((b.top3 / b.n) * 100).toFixed(1)}% (${b.top3}/${b.n})`
    );
  }

  // ---- 自分自身の級で層別（単なる自分の実力の言い換えでないか確認） ----
  type Bucket3 = "格上先頭" | "同格先頭" | "格下先頭";
  const byOwnClass = new Map<string, Record<Bucket3, { n: number; win: number; top3: number }>>();
  for (const [, members] of byRaceLine) {
    const senko = members.find((m) => m.line_position === "先頭");
    if (!senko || !senko.class_rank) continue;
    const senkoScore = CLASS_RANK_SCORES[senko.class_rank];
    if (senkoScore == null) continue;

    for (const m of members) {
      if (m.line_position !== "番手" && m.line_position !== "3番手") continue;
      if (!m.class_rank) continue;
      const myScore = CLASS_RANK_SCORES[m.class_rank];
      if (myScore == null) continue;

      const bucket: Bucket3 =
        senkoScore > myScore ? "格上先頭" : senkoScore < myScore ? "格下先頭" : "同格先頭";
      const ownGroup =
        byOwnClass.get(m.class_rank) ??
        { 格上先頭: { n: 0, win: 0, top3: 0 }, 同格先頭: { n: 0, win: 0, top3: 0 }, 格下先頭: { n: 0, win: 0, top3: 0 } };
      ownGroup[bucket].n++;
      if (m.finish_pos === 1) ownGroup[bucket].win++;
      if (m.finish_pos <= 3) ownGroup[bucket].top3++;
      byOwnClass.set(m.class_rank, ownGroup);
    }
  }

  console.log("\n■ 自分自身の級班ごとに層別（自分の実力の言い換えでないか確認）:");
  for (const [classRank, group] of [...byOwnClass.entries()].sort(
    (a, b) => (CLASS_RANK_SCORES[b[0]] ?? 0) - (CLASS_RANK_SCORES[a[0]] ?? 0)
  )) {
    console.log(`  [自分が${classRank}]`);
    for (const label of ["格上先頭", "同格先頭", "格下先頭"] as const) {
      const b = group[label];
      if (b.n < 30) continue;
      console.log(`    ${label}: 単勝的中率${((b.win / b.n) * 100).toFixed(1)}% (${b.win}/${b.n})`);
    }
  }
}

main();
