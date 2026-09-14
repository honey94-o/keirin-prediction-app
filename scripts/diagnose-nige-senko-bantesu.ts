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
import { CLASS_RANK_SCORES } from "../lib/scoring";

/**
 * 【検証結果: 不採用（相関自体は本物だが、既存スコアリングに混ぜても実益なし）】
 *
 * ユーザー仮説「脚質=逃の選手は、先頭でレースした時より番手でレースをした時
 * （捲るかどうかは別で）の方が勝率が高いのでは」の検証。
 *
 * 全体（脚質=逃、先頭 or 番手固定、n=23421）:
 *   先頭: 勝率23.0%(train23.5%/test22.1%, n=22237)
 *   番手: 勝率25.8%(train26.0%/test25.3%, n=1184)
 * train/testとも番手が先頭を上回り、一見仮説を支持するように見える。
 *
 * ただしheikin_tokutenで統制すると単純な交絡ではなく交互作用と判明した：
 *   低位帯: 先頭21.7% 番手14.4%（番手の方が低い＝逆転）
 *   中位帯: 先頭25.5% 番手27.9%（ほぼ同等）
 *   高位帯: 先頭21.8% 番手32.5%（番手が大幅に高い、train32.7%/test32.0%で安定）
 * 先頭の勝率は自分の強さ（tokuten）にほぼ依らず21-25%台で頭打ちなのに対し、
 * 番手の勝率は自分の強さに比例して14%→28%→33%と単調に伸びる。「先頭は自分の
 * 強さによらず消耗するポジション、番手は強い選手ほど番手捲りで主導権を握れる
 * ポジション」という解釈と整合する。
 *
 * 既存のスコアリング入力であるclass_rank（CLASS_RANK_SCORES）で層別しても
 * 同じ交互作用が再現し、tokutenの言い換えではないと確認した：
 *   SS(100点): 先頭28.1% 番手43.8%（n=16、参考）
 *   S1(85点) : 先頭21.4%(train22.9/test18.7) 番手39.2%(train42.2/test34.0) ← 番手が大幅に高い
 *   S2(70点) : 先頭19.8%(train21.4/test16.7) 番手27.8%(train27.2/test28.9) ← 番手が高い
 *   A1(55点) : 先頭23.2%(train22.9/test23.8) 番手28.9%(train27.3/test32.3) ← 番手が高い
 *   A2(40点) : 先頭23.9%(train26.8/test18.0) 番手13.2%(train15.3/test8.9)  ← 先頭が大幅に高い（逆転）
 *   A3(25点) : 先頭24.2%(train21.3/test29.4) 番手17.2%(train16.7/test17.8) ← 先頭が高い（逆転）
 * class_rank換算55点（A1）以上では番手が先頭を上回り、55点未満（A2以下）では
 * 逆に先頭が番手を上回る。境目も含めてtrain/testどちらでも同じ方向に再現した。
 *
 * 対応: calculateKyakushitsuScoreの脚質=逃のfitScoreに、classRankScore>=55かどうかの
 * 交互作用を試験導入（先頭95→高クラス85・番手90→高クラス100、低クラスは
 * 先頭95・番手70に強調）。backtest.ts --limit=3000で同一レース集合の変更前後を比較：
 *   ◎単勝的中率  : 42.0%(1261/2999) → 42.4%(1271/2999)   （+0.4pt、誤差範囲）
 *   ◎複勝的中率  : 76.3%(2288)      → 76.3%(2287)          （ほぼ無変化）
 *   本命回収率    : 111.5%           → 110.3%                （-1.2pt）
 *   逃げ粘り込み  : 的中6.7%/回収84.2% → 的中6.9%/回収86.0%   （わずかに改善）
 *   まくり/差し一撃: 的中7.4%/回収100.3% → 的中7.0%/回収99.6% （わずかに悪化）
 *   全シナリオ合成: 的中33.5%/回収102.7% → 的中33.4%/回収102.9%（ほぼ無変化）
 * 一部シナリオは改善、一部は悪化と方向が割れ、全体としては誤差範囲内の
 * 揺れに留まった。相関自体（class_rankとの交互作用）は真であることを
 * 上のクエリ結果で確認済みだが、totalScoreは既にclassRankScore・winRateScore・
 * placeRateScoreを通じて本人の強さを別ルートで織り込んでおり、fitScore側だけを
 * 動かしても軸選定（scored[0]・逃げ粘り込み・まくり/差し一撃の各候補選定）への
 * 実質的な影響は限定的だった。単独では強い相関でもスコアに混ぜると効果が
 * 消える／不明瞭になるという、地元ボーナスや同県ライン加点削除、
 * class_rank起因の他の交互作用調整（LINE_RANK_BONUS/PENALTY=0）でも見られたのと
 * 同じパターンと判断し、変更は revert して不採用とした（2026-09-14）。
 */

type Rec = { linePos: string; win: boolean; classScore: number; date: string };

async function main() {
  const db = getDb();
  const entRes = await db.execute(`
    SELECT e.race_id, e.car_num, e.line_position, r.kyakushitsu, r.class_rank, ra.kaisai_date
    FROM entries e
    JOIN racers r ON r.snum = e.snum
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%' AND r.kyakushitsu = '逃' AND e.line_position IN ('先頭','番手')
  `);
  type EntRow = {
    race_id: number;
    car_num: number;
    line_position: string;
    kyakushitsu: string | null;
    class_rank: string | null;
    kaisai_date: string;
  };
  const rows = entRes.rows as unknown as EntRow[];
  const raceIds = [...new Set(rows.map((r) => r.race_id))];

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
  for (const e of rows) {
    const fp = finishByRaceCar.get(`${e.race_id}:${e.car_num}`);
    if (fp == null || !e.class_rank) continue;
    const classScore = CLASS_RANK_SCORES[e.class_rank] ?? 50;
    records.push({ linePos: e.line_position, win: fp === 1, classScore, date: e.kaisai_date });
  }

  const dates = [...new Set(records.map((r) => r.date))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  function rate(a: Rec[]): string {
    return a.length ? ((100 * a.filter((r) => r.win).length) / a.length).toFixed(1) + "%(n=" + a.length + ")" : "-";
  }

  console.log("=== classRankScore >= 55 (A1以上) ===");
  const high = records.filter((r) => r.classScore >= 55);
  const highSenko = high.filter((r) => r.linePos === "先頭");
  const highBante = high.filter((r) => r.linePos === "番手");
  console.log(`先頭: 全体${rate(highSenko)} train${rate(highSenko.filter((r) => r.date < split))} test${rate(highSenko.filter((r) => r.date >= split))}`);
  console.log(`番手: 全体${rate(highBante)} train${rate(highBante.filter((r) => r.date < split))} test${rate(highBante.filter((r) => r.date >= split))}`);

  console.log("\n=== classRankScore < 55 (A2以下) ===");
  const low = records.filter((r) => r.classScore < 55);
  const lowSenko = low.filter((r) => r.linePos === "先頭");
  const lowBante = low.filter((r) => r.linePos === "番手");
  console.log(`先頭: 全体${rate(lowSenko)} train${rate(lowSenko.filter((r) => r.date < split))} test${rate(lowSenko.filter((r) => r.date >= split))}`);
  console.log(`番手: 全体${rate(lowBante)} train${rate(lowBante.filter((r) => r.date < split))} test${rate(lowBante.filter((r) => r.date >= split))}`);
}

main();
