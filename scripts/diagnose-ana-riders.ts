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
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { getDb } from "../lib/db";

// ユーザー依頼：単騎（ラインが自分1人）または3番手から1着になり、かつ高額配当を
// よく出している選手を見つけて「推奨穴買い目」の候補にしたい。
// 落車・失格の選手がいたレースは、他の選手が「恵まれて」上位に来た可能性があるため除外する。
//
// 除外の判定：results.finish_pos は数字以外（失格/落車/欠 等）の行を
// scraper側でスキップして保存しているため、レース単位でentries数とresults数を
// 比較し、entries > results のレースを「非完走者がいた」とみなして除外する
// （scripts/_tmp_check_dnf.tsで実データ147件を確認済み）。
//
// 「高額配当」は個々の選手の単勝オッズが無い（odds.bet_typeは3連単のみ）ため、
// その選手が勝った時の実際の3連単配当（払戻）を代理指標として使う。

async function main() {
  const db = getDb();

  // ①非完走者がいたレースを除外リスト化
  const dnfRows = await db.execute(`
    SELECT e.race_id, COUNT(DISTINCT e.car_num) entries, COUNT(DISTINCT r.car_num) results
    FROM entries e
    LEFT JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    GROUP BY e.race_id
    HAVING entries > results
  `);
  const excludedRaceIds = new Set(
    (dnfRows.rows as unknown as { race_id: number }[]).map((r) => r.race_id)
  );
  console.log(`非完走者ありで除外するレース: ${excludedRaceIds.size}件`);

  // ②全レースの結果（着順）とライン情報をまとめて取得
  const resultRows = await db.execute(`
    SELECT race_id, car_num, snum, finish_pos FROM results WHERE finish_pos IS NOT NULL
  `);
  const results = resultRows.rows as unknown as {
    race_id: number;
    car_num: number;
    snum: string;
    finish_pos: number;
  }[];

  const entryRows = await db.execute(`
    SELECT e.race_id, e.car_num, e.snum, e.line_group, e.line_position, r.class_rank
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    WHERE e.line_group IS NOT NULL
  `);
  const allEntries = entryRows.rows as unknown as {
    race_id: number;
    car_num: number;
    snum: string;
    line_group: number;
    line_position: string | null;
    class_rank: string | null;
  }[];

  // ガールズケイリンは全選手が常にライン1人（単騎相当）で走るため、
  // 「単騎」の希少性・意味自体が男子レースと異なる。分析対象は男子レースに絞る
  // （isGirlsRace: L級選手が1人でもいればガールズレースとみなす、lib/scoring.tsと同じ判定）。
  const girlsRaceIds = new Set(
    allEntries.filter((e) => e.class_rank?.startsWith("L")).map((e) => e.race_id)
  );
  const entries = allEntries.filter((e) => !girlsRaceIds.has(e.race_id));
  console.log(`ガールズレースとして除外: ${girlsRaceIds.size}レース`);

  // race_id+line_group -> そのラインの人数
  const lineSizeMap = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.race_id}_${e.line_group}`;
    lineSizeMap.set(key, (lineSizeMap.get(key) ?? 0) + 1);
  }
  const entryByRaceCar = new Map<string, (typeof entries)[number]>();
  for (const e of entries) entryByRaceCar.set(`${e.race_id}_${e.car_num}`, e);

  // race_id -> 着順昇順のresults（実際の上位3頭で3連単オッズを引くため）
  const resultsByRace = new Map<number, typeof results>();
  for (const r of results) {
    const arr = resultsByRace.get(r.race_id) ?? [];
    arr.push(r);
    resultsByRace.set(r.race_id, arr);
  }

  // ③単騎(ライン1人)または3番手から1着になったケースを抽出
  type Win = { raceId: number; snum: string; carNum: number; qualifier: "単騎" | "3番手" };
  const wins: Win[] = [];
  for (const r of results) {
    if (r.finish_pos !== 1) continue;
    if (excludedRaceIds.has(r.race_id)) continue;
    const entry = entryByRaceCar.get(`${r.race_id}_${r.car_num}`);
    if (!entry) continue;
    const lineSize = lineSizeMap.get(`${r.race_id}_${entry.line_group}`) ?? 0;
    if (lineSize === 1) {
      wins.push({ raceId: r.race_id, snum: r.snum, carNum: r.car_num, qualifier: "単騎" });
    } else if (entry.line_position === "3番手") {
      wins.push({ raceId: r.race_id, snum: r.snum, carNum: r.car_num, qualifier: "3番手" });
    }
  }
  console.log(`単騎/3番手からの1着（非完走者ありレース除外後）: ${wins.length}件`);

  // ④それぞれの勝利について、実際の3連単配当を取得
  const oddsRows = await db.execute(`SELECT race_id, combination, odds_value FROM odds WHERE bet_type = '3連単'`);
  const oddsByRace = new Map<number, Map<string, number>>();
  for (const o of oddsRows.rows as unknown as { race_id: number; combination: string; odds_value: number }[]) {
    const m = oddsByRace.get(o.race_id) ?? new Map<string, number>();
    m.set(o.combination, o.odds_value);
    oddsByRace.set(o.race_id, m);
  }

  type WinWithPayout = Win & { payoutYen: number | null; combo: string | null };
  const winsWithPayout: WinWithPayout[] = wins.map((w) => {
    const raceResults = (resultsByRace.get(w.raceId) ?? [])
      .filter((r) => r.finish_pos <= 3)
      .sort((a, b) => a.finish_pos - b.finish_pos);
    if (raceResults.length < 3) return { ...w, payoutYen: null, combo: null };
    const combo = raceResults.map((r) => r.car_num).join("-");
    const oddsValue = oddsByRace.get(w.raceId)?.get(combo) ?? null;
    return { ...w, payoutYen: oddsValue != null ? oddsValue * 100 : null, combo };
  });

  // ⑤選手別に集計（払戻データがあるものだけ）
  const bySnum = new Map<
    string,
    { wins: number; totalPayout: number; maxPayout: number; races: { raceId: number; payoutYen: number; combo: string }[] }
  >();
  for (const w of winsWithPayout) {
    if (w.payoutYen == null || w.combo == null) continue;
    const agg = bySnum.get(w.snum) ?? { wins: 0, totalPayout: 0, maxPayout: 0, races: [] };
    agg.wins += 1;
    agg.totalPayout += w.payoutYen;
    agg.maxPayout = Math.max(agg.maxPayout, w.payoutYen);
    agg.races.push({ raceId: w.raceId, payoutYen: w.payoutYen, combo: w.combo });
    bySnum.set(w.snum, agg);
  }

  // 選手名を引く
  const snumRows = await db.execute("SELECT snum, name FROM racers");
  const nameBySnum = new Map(
    (snumRows.rows as unknown as { snum: string; name: string }[]).map((r) => [r.snum, r.name])
  );

  const MIN_WINS = 2; // 一発屋を除くため複数回の実績がある選手に絞る
  const ranked = [...bySnum.entries()]
    .filter(([, agg]) => agg.wins >= MIN_WINS)
    .map(([snum, agg]) => ({ snum, name: nameBySnum.get(snum) ?? snum, ...agg, avgPayout: agg.totalPayout / agg.wins }))
    .sort((a, b) => b.avgPayout - a.avgPayout);

  console.log(`\n=== 単騎/3番手から複数回(${MIN_WINS}回以上)勝ち、高額配当を出している選手 ===`);
  for (const r of ranked.slice(0, 30)) {
    console.log(
      `  ${r.name}(${r.snum}): ${r.wins}勝 平均配当${r.avgPayout.toFixed(0)}円 最高${r.maxPayout.toFixed(0)}円`
    );
    for (const race of r.races) {
      console.log(`      race_id=${race.raceId} ${race.combo} ${race.payoutYen.toFixed(0)}円`);
    }
  }
}

main();
