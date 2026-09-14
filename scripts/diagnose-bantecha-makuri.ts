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

/**
 * 【検証結果: 採用（lib/scoring.tsのまくり/差し一撃候補選定に反映済み）】
 * ユーザー指摘「脚質が逃や両の選手が番手の時、番手捲りをすることがある。
 * 番手捲りした時、ライン先頭はほぼ着外になる」の検証。
 *
 * 「番手捲り」自体の記録は無いため、「番手が自ラインの先頭より良い着順で
 * ゴールしたか」（diagnose-shb-overtake.tsと同じ定義）を代理指標にする。
 *
 * 結果（番手の脚質別、先頭を上回る率）:
 *   逃: 58.5%（train58.3%/test58.7%, n=1175）
 *   両: 54.7%（train54.1%/test55.7%, n=5359）
 *   追: 47.9%（train47.8%/test48.2%, n=20634）
 * 逃・両ともに追よりはっきり高く、train/testで再現。
 *
 * 「上回った時、先頭は4着以下（≒着外）」の率:
 *   逃/両が上回った時: 72.5%（統制なしの全体は53.1%）
 *   追が上回った時    : 75.3%（統制なしの全体は50.3%）
 * 上回った時に先頭が着外になりやすいこと自体は再現するが、この部分は
 * 脚質に依らずほぼ同じ（追でもむしろ僅かに高い）。つまり「番手捲りすると
 * 先頭が着外になりやすい」は本当だが、脚質固有の効果ではなく「番手が
 * 先頭を上回る＝ライン想定が崩れた」こと自体の帰結と考えられる
 * （diagnose-bantecha-makuri-confound.tsでstanding_countとの交絡も確認済み、
 * 交絡ではなく独立した信号と判断）。
 *
 * 対応: lib/scoring.tsのまくり/差し一撃候補選定が脚質「追・両」のみを対象と
 * しており、最も上回り率が高い「逃」を除外していたため対象に加えた。
 * backtest.ts(3000レース、変更前後で同一レース集合)で確認：
 * まくり/差し一撃 的中率7.0%→7.3%・回収率97.4%→100.1%、他シナリオへの
 * 悪影響なし。
 */

type Rec = { kyakushitsu: string | null; overtook: boolean; senkoFinish: number; date: string };

async function main() {
  const db = getDb();
  const entRes = await db.execute(`
    SELECT e.race_id, e.car_num, e.line_group, e.line_position, r.kyakushitsu, ra.kaisai_date
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%' AND e.line_position IS NOT NULL
  `);
  type EntRow = { race_id: number; car_num: number; line_group: number | null; line_position: string; kyakushitsu: string | null; kaisai_date: string };
  const rows = entRes.rows as unknown as EntRow[];
  const byRace = new Map<number, EntRow[]>();
  for (const e of rows) {
    const a = byRace.get(e.race_id) ?? [];
    a.push(e);
    byRace.set(e.race_id, a);
  }
  const raceIds = [...byRace.keys()];

  const resultsRows: { race_id: number; car_num: number; finish_pos: number }[] = [];
  const CHUNK = 2000;
  for (let i = 0; i < raceIds.length; i += CHUNK) {
    const chunk = raceIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT race_id, car_num, finish_pos FROM results WHERE race_id IN (${placeholders}) AND finish_pos IS NOT NULL`,
      args: chunk,
    });
    resultsRows.push(...(r.rows as unknown as { race_id: number; car_num: number; finish_pos: number }[]));
  }
  const finishByRaceCar = new Map<string, number>();
  for (const r of resultsRows) finishByRaceCar.set(`${r.race_id}:${r.car_num}`, r.finish_pos);

  const records: Rec[] = [];
  for (const [raceId, entries] of byRace) {
    const lineGroups = new Map<number, EntRow[]>();
    for (const e of entries) {
      if (e.line_group == null) continue;
      const a = lineGroups.get(e.line_group) ?? [];
      a.push(e);
      lineGroups.set(e.line_group, a);
    }
    for (const members of lineGroups.values()) {
      const senko = members.find((m) => m.line_position === "先頭");
      const bantesu = members.find((m) => m.line_position === "番手");
      if (!senko || !bantesu) continue;
      const senkoFinish = finishByRaceCar.get(`${raceId}:${senko.car_num}`);
      const bantesuFinish = finishByRaceCar.get(`${raceId}:${bantesu.car_num}`);
      if (senkoFinish == null || bantesuFinish == null) continue;
      records.push({
        kyakushitsu: bantesu.kyakushitsu,
        overtook: bantesuFinish < senkoFinish,
        senkoFinish,
        date: bantesu.kaisai_date,
      });
    }
  }

  console.log(`\n対象（先頭・番手ともに着順判明しているライン）: ${records.length}件\n`);
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];

  function rate(data: Rec[]): string {
    return data.length ? ((100 * data.filter((r) => r.overtook).length) / data.length).toFixed(1) + "%" : "-";
  }
  function senkoOutRate(data: Rec[]): string {
    const ot = data.filter((r) => r.overtook);
    return ot.length ? ((100 * ot.filter((r) => r.senkoFinish >= 4).length) / ot.length).toFixed(1) + "%" : "-";
  }

  for (const k of ["逃", "両", "追"]) {
    const b = records.filter((r) => r.kyakushitsu === k);
    const train = b.filter((r) => r.date < split);
    const test = b.filter((r) => r.date >= split);
    console.log(`番手の脚質=${k} n=${b.length}`);
    console.log(`  先頭を上回る率: 全体${rate(b)} train${rate(train)} test${rate(test)}`);
    console.log(`  (上回った時)先頭が4着以下だった率: ${senkoOutRate(b)}`);
  }
}

main();
