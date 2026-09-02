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
 * 単騎（同じline_groupが自分だけ）選手の脚質別勝率を、複数人ライン先頭と比較する。
 * 現行のcalculateKyakushitsuScoreのfitScoreは「先頭」ポジションを単騎も複数人
 * ラインの先頭も同じ扱いにしている（ライン人数の効果はcalculateLineScore側の
 * 別項目として加点しているため、独立だと想定していた）。だが単騎特有の
 * 脚質差がある可能性を検証する。
 */

async function main() {
  const db = getDb();

  const entriesResult = await db.execute(`
    SELECT e.race_id, e.snum, e.car_num, e.line_group, e.line_position,
           r.finish_pos, rc.kyakushitsu
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    JOIN racers rc ON rc.snum = e.snum
    WHERE r.finish_pos IS NOT NULL
    ORDER BY e.race_id
  `);
  type Row = {
    race_id: number;
    snum: string;
    car_num: number;
    line_group: number | null;
    line_position: string | null;
    finish_pos: number;
    kyakushitsu: string | null;
  };
  const entries = entriesResult.rows as unknown as Row[];
  console.log(`結果確定済み出走: ${entries.length}件\n`);

  const byRaceLine = new Map<string, Row[]>();
  for (const e of entries) {
    const key = e.line_group != null ? `${e.race_id}:${e.line_group}` : `${e.race_id}:solo:${e.car_num}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(e);
    byRaceLine.set(key, arr);
  }

  const soloStats = new Map<string, { n: number; win: number }>();
  const groupSenkoStats = new Map<string, { n: number; win: number }>();
  for (const [, members] of byRaceLine) {
    const senko = members.find((m) => m.line_position === "先頭") ?? (members.length === 1 ? members[0] : null);
    if (!senko || !senko.kyakushitsu) continue;
    const target = members.length === 1 ? soloStats : groupSenkoStats;
    const b = target.get(senko.kyakushitsu) ?? { n: 0, win: 0 };
    b.n++;
    if (senko.finish_pos === 1) b.win++;
    target.set(senko.kyakushitsu, b);
  }

  console.log("■ 単騎 vs 複数人ライン先頭、脚質別勝率:");
  for (const kyakushitsu of ["逃", "両", "追"]) {
    const solo = soloStats.get(kyakushitsu);
    const group = groupSenkoStats.get(kyakushitsu);
    console.log(
      `  ${kyakushitsu}: 単騎 勝率${solo ? ((solo.win / solo.n) * 100).toFixed(1) : "-"}% (${solo?.win}/${solo?.n}) ` +
        `/ 複数人ライン先頭 勝率${group ? ((group.win / group.n) * 100).toFixed(1) : "-"}% (${group?.win}/${group?.n})`
    );
  }
}

main();
