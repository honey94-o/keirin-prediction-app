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

import { getDb, closeDb } from "../lib/db";

/**
 * 【検証結果: 採用（lib/scoring.tsのorderBarikataSecondThirdとして実装済み）】
 *
 * ユーザー指摘「バリカタの的中率が悪い。買い目の形式（単一の並び、1点100円）は
 * 変えずに的中率を上げたい」を受けての検証。武雄7R(2026-09-16)を含む直近の
 * 実績を見ると、◎（軸）は当たっているのに2-3着の順番だけ入れ替わって外れる
 * ケースが目立った（例:「1-7-4」実際「1-7-3」、「2-5-4」実際「2-5-3」）。
 *
 * バリカタは同ライン限定（scripts/compute-picks.tsのmarginCandidates参照）で、
 * 2着・3着は総合スコア順（scored[1]・scored[2]）にしていた。しかし同じライン
 * 内では、各選手の隊列上の役割（先頭=引く役、番手=差す役、3番手=さらに後ろ）が
 * 個人の総合スコアより実際の着順を決めやすいのではという仮説を検証した。
 *
 * ■ 方法
 * predictions テーブル（total_score降順で本命/対抗/3位を復元、scripts/
 * diagnose-interview-exclusion.ts等と同じ高速な手法）とentries.line_position を
 * 突き合わせ、encp LIKE 'wt:%'・9車立て除外・margin>=8（BARIKATA_MIN_MARGIN）・
 * 予想1-2-3位が同ラインの母集団（n=369）で検証。train/testは開催日で2/3・1/3の
 * クロノロジカル分割。
 *
 * ■ 結果
 * 2着(scored[1])と3着(scored[2])の隊列順位（先頭<番手<3番手<4番手）を比較すると：
 *   スコア順=隊列順（2着の方が隊列上前）: n=308（83.5%） 現行の的中率29.5%
 *   スコア順≠隊列順（2着の方が隊列上後ろ）: n=61（16.5%）  現行の的中率わずか8.2%
 * 後者（n=61）で2-3着を隊列順に並べ替えた場合の的中率を試算すると21.3%まで
 * 回復した。train/testで安定して同方向：
 *   現行(スコア順)    : 全体8.2%  train4.9%(n=41)  test15.0%(n=20)
 *   新(隊列順で補正)  : 全体21.3% train14.6%(n=41) test35.0%(n=20)
 * 全体（n=369）で見ても現行26.0%→新28.2%（train24.5%→26.1%・test29.2%→32.5%、
 * train/testとも改善・逆転なし）。スコア順と隊列順が一致する多数派（n=308）は
 * 変更の影響を受けないため、ダウンサイドは無い。
 *
 * ■ 対応
 * lib/scoring.tsにorderBarikataSecondThird(second, third, sameLine)を追加し、
 * 同ラインの時だけ隊列順（先頭<番手<3番手<4番手）で2-3着を並べ替えるよう
 * scripts/compute-picks.tsのmarginCandidates構築を変更した。買い目の点数・
 * 形式（単一の並び、1点100円）は変えていない。
 */

type Rec = {
  date: string;
  currentHit: boolean;
  newHit: boolean;
  changed: boolean;
};

const LINE_POSITION_RANK: Record<string, number> = { 先頭: 1, 番手: 2, "3番手": 3, "4番手": 4 };

async function main() {
  const db = getDb();

  const predRes = await db.execute(`
    SELECT p.race_id, p.car_num, p.total_score, ra.kaisai_date
    FROM predictions p
    JOIN races ra ON ra.id = p.race_id
    WHERE ra.encp LIKE 'wt:%'
  `);
  type PredRow = { race_id: number; car_num: number; total_score: number; kaisai_date: string };
  const predRows = predRes.rows as unknown as PredRow[];
  const byRace = new Map<number, PredRow[]>();
  for (const row of predRows) {
    const a = byRace.get(row.race_id) ?? [];
    a.push(row);
    byRace.set(row.race_id, a);
  }

  const entRes = await db.execute(`
    SELECT e.race_id, e.car_num, e.line_group, e.line_position
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%'
  `);
  type EntRow = { race_id: number; car_num: number; line_group: number | null; line_position: string | null };
  const entRows = entRes.rows as unknown as EntRow[];
  const entByRaceCar = new Map<string, EntRow>();
  for (const e of entRows) entByRaceCar.set(`${e.race_id}:${e.car_num}`, e);

  const raceIds = [...byRace.keys()];
  const CHUNK = 2000;
  const resultsRows: { race_id: number; car_num: number; finish_pos: number }[] = [];
  for (let i = 0; i < raceIds.length; i += CHUNK) {
    const chunk = raceIds.slice(i, i + CHUNK);
    const r = await db.execute({
      sql: `SELECT race_id, car_num, finish_pos FROM results WHERE race_id IN (${chunk.map(() => "?").join(",")}) AND finish_pos IS NOT NULL`,
      args: chunk,
    });
    resultsRows.push(...(r.rows as unknown as { race_id: number; car_num: number; finish_pos: number }[]));
  }
  const top3ByRace = new Map<number, { car_num: number; finish_pos: number }[]>();
  for (const r of resultsRows) {
    if (r.finish_pos > 3) continue;
    const a = top3ByRace.get(r.race_id) ?? [];
    a.push(r);
    top3ByRace.set(r.race_id, a);
  }

  const records: Rec[] = [];
  for (const [raceId, rows] of byRace) {
    if (rows.length < 3 || rows.length === 9) continue;
    const sorted = [...rows].sort((a, b) => b.total_score - a.total_score);
    const top3pred = sorted.slice(0, 3);
    const margin = sorted[0].total_score - sorted[1].total_score;
    if (margin < 8) continue;

    const e0 = entByRaceCar.get(`${raceId}:${top3pred[0].car_num}`);
    const e1 = entByRaceCar.get(`${raceId}:${top3pred[1].car_num}`);
    const e2 = entByRaceCar.get(`${raceId}:${top3pred[2].car_num}`);
    if (!e0 || !e1 || !e2) continue;
    const sameLine = e0.line_group != null && e0.line_group === e1.line_group && e1.line_group === e2.line_group;
    if (!sameLine) continue;

    const rank1 = LINE_POSITION_RANK[e1.line_position ?? ""] ?? 99;
    const rank2 = LINE_POSITION_RANK[e2.line_position ?? ""] ?? 99;
    const changed = rank2 < rank1;

    const actualTop3 = top3ByRace.get(raceId);
    if (!actualTop3 || actualTop3.length < 3) continue;
    actualTop3.sort((a, b) => a.finish_pos - b.finish_pos);
    const actualCombo = actualTop3.map((r) => r.car_num).join("-");
    const currentCombo = top3pred.map((r) => r.car_num).join("-");
    const newCombo = changed
      ? [top3pred[0].car_num, top3pred[2].car_num, top3pred[1].car_num].join("-")
      : currentCombo;

    records.push({
      date: sorted[0].kaisai_date,
      currentHit: currentCombo === actualCombo,
      newHit: newCombo === actualCombo,
      changed,
    });
  }

  console.log(`母数: ${records.length}件（うち並べ替え対象: ${records.filter((r) => r.changed).length}件）\n`);

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  function rate(a: Rec[], key: "currentHit" | "newHit"): string {
    return a.length ? `${((100 * a.filter((r) => r[key]).length) / a.length).toFixed(1)}%(n=${a.length})` : "-";
  }
  const train = records.filter((r) => r.date < split);
  const test = records.filter((r) => r.date >= split);

  console.log(`現行(score順)   : 全体${rate(records, "currentHit")} train${rate(train, "currentHit")} test${rate(test, "currentHit")}`);
  console.log(`新(隊列順で補正): 全体${rate(records, "newHit")} train${rate(train, "newHit")} test${rate(test, "newHit")}\n`);

  const changed = records.filter((r) => r.changed);
  const changedTrain = changed.filter((r) => r.date < split);
  const changedTest = changed.filter((r) => r.date >= split);
  console.log(`--- 並べ替え対象のみ(n=${changed.length}) ---`);
  console.log(`現行: 全体${rate(changed, "currentHit")} train${rate(changedTrain, "currentHit")} test${rate(changedTest, "currentHit")}`);
  console.log(`新  : 全体${rate(changed, "newHit")} train${rate(changedTrain, "newHit")} test${rate(changedTest, "newHit")}`);

  await closeDb();
}

main();
