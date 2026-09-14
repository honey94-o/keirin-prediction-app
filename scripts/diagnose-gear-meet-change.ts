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

import { getDb, closeDb } from "../lib/db";
import { parseEncp } from "../lib/date";

/**
 * 【検証結果: 不採用（サンプル不足のため検証自体が成立しない）】
 *
 * ユーザー仮説：同一開催（開催=races.encpのcupId、"wt:{cupId}/{day}/{raceNo}"）の中で、
 * 選手が出走の早い段階（予選等）から遅い段階（準決勝・決勝等）にかけて
 * entries.gear_ratio（このレースでのギア倍数、選手個々・レースごと）を上げている場合、
 * 「ギアを上げる」＝自信・積極性のサインとして、その選手の later race での勝率が
 * 上がるのではないか、という仮説の検証（diagnose-gear-ratio-deviation.tsで検証済みの
 * 「本人の通算平均ギアからの乖離」とは別の、開催内での前半→後半の変化に着目した仮説）。
 *
 * syumoku（予選/準決勝/決勝等）は表記ゆれが激しく厳密なステージ順序を組み立てるのは
 * 危険なため、単純に「同一cupId内でのその選手の最初の出走」と「最後の出走」の
 * gear_ratioを比較する方式にした（kaisai_date→race_noの順でソート）。
 *
 * ■ Step1: フィージビリティチェック
 * 同一cupId内でgear_ratioが非nullの出走を2回以上した(snum, cupId)組は27,750件
 * （wt:接頭のレース全体、distinct cupId数=403）。このうち最初の出走と最後の出走で
 * gear_ratioが変化した組は:
 *   上げた: 232件（0.84%）
 *   下げた: 170件（0.61%）
 *   変えず: 27,348件（98.55%）
 * 変化の絶対値の分布（diffの内訳、上位）を見ると 0.07/0.01/0.06/0.08 といった
 * 実際のギア倍数の刻み幅と一致する現実的な値であり、丸め誤差ではなく実データ上の
 * 変更であることは確認できた（例: 3.85→3.92、3.83→3.92等）。
 *
 * つまり「開催内でギアを変える」という行動自体は実在するが、全体のわずか1.45%
 * （上げ下げ合計）にしか発生しない稀な事象で、「上げた」だけに絞ると0.84%
 * （232/27,750）しかない。事前に決めていた基準（変化率2%未満なら「実質変えない」
 * と見なしてhold）を下回ったため、ここで打ち切った。
 *
 * 232件を仮にtrain/testで2/3・1/3に割ると test側はせいぜい70〜80件程度になり、
 * さらにuser指定の交絡チェック（heikin_tokuten三分位×class_rank）で層別すると
 * 各セルが一桁〜十数件になってしまう。この規模では「上げた群の勝率が高かった/
 * 低かった」という結果が出たとしても、たまたま数件のレース結果に左右された
 * ノイズと、真の効果を統計的に区別できない。過去の類似ケース
 * （diagnose-gear-ratio-deviation.ts等）のように「相関は本物だが交絡だった」
 * 以前の問題として、母集団が薄すぎて検証自体が成立しない。
 *
 * 対応：Step2（勝率比較）・Step3（backtest.ts）には進まず、ここで不採用として
 * 記録する。lib/scoring.tsへの変更は行っていない。
 *
 * 参考：ギアを「変える」選手自体が稀（1.45%）という事実は、逆に言えば
 * 「そもそもgear_ratioは開催中ほぼ固定される数値」であることを示している
 * （機材面の制約か、選手が開催前に決めた設定を通す運用が大半と考えられる）。
 * 今後この方向で再挑戦するなら、cupId単位ではなく「同一選手の生涯の
 * gear_ratio変更イベント」を全開催横断で集めるなど、母数の取り方を変える
 * 必要がある。
 */

type Row = {
  snum: string;
  cup_id: string;
  kaisai_date: string;
  race_no: number;
  gear_ratio: number;
};

async function main() {
  const db = getDb();
  const result = await db.execute(`
    SELECT e.snum, ra.encp, ra.kaisai_date, ra.race_no, e.gear_ratio
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    WHERE ra.encp LIKE 'wt:%' AND e.gear_ratio IS NOT NULL
  `);
  type RawRow = { snum: string; encp: string; kaisai_date: string; race_no: number; gear_ratio: number };
  const raw = result.rows as unknown as RawRow[];

  // (snum, cupId)ごとにレースを集める
  const byPair = new Map<string, Row[]>();
  for (const r of raw) {
    const parsed = parseEncp(r.encp);
    if (!parsed) continue;
    const key = `${r.snum}:${parsed.cupId}`;
    const arr = byPair.get(key) ?? [];
    arr.push({ snum: r.snum, cup_id: parsed.cupId, kaisai_date: r.kaisai_date, race_no: r.race_no, gear_ratio: r.gear_ratio });
    byPair.set(key, arr);
  }

  const cupIds = new Set(raw.map((r) => parseEncp(r.encp)?.cupId).filter(Boolean));
  console.log(`対象レース（wt:接頭、gear_ratio非null）: ${raw.length}件`);
  console.log(`distinct cupId数: ${cupIds.size}`);

  let pairsWithMulti = 0;
  let increased = 0;
  let decreased = 0;
  let unchanged = 0;
  const EPS = 0.001; // gear_ratioは小数第2位刻みが基本のため、これ未満は丸め誤差扱い

  for (const races of byPair.values()) {
    if (races.length < 2) continue;
    pairsWithMulti++;
    const sorted = [...races].sort(
      (a, b) => a.kaisai_date.localeCompare(b.kaisai_date) || a.race_no - b.race_no
    );
    const first = sorted[0].gear_ratio;
    const last = sorted[sorted.length - 1].gear_ratio;
    const diff = last - first;
    if (diff > EPS) increased++;
    else if (diff < -EPS) decreased++;
    else unchanged++;
  }

  console.log(`\n同一cupId内でgear_ratio非nullの出走が2回以上ある(snum, cupId)組: ${pairsWithMulti}件`);
  console.log(`  最初→最後で上げた: ${increased}件 (${((100 * increased) / pairsWithMulti).toFixed(2)}%)`);
  console.log(`  最初→最後で下げた: ${decreased}件 (${((100 * decreased) / pairsWithMulti).toFixed(2)}%)`);
  console.log(`  変えず          : ${unchanged}件 (${((100 * unchanged) / pairsWithMulti).toFixed(2)}%)`);

  const changedPct = (100 * (increased + decreased)) / pairsWithMulti;
  console.log(`\n変化率（上げ下げ合計）: ${changedPct.toFixed(2)}%`);
  if (changedPct < 2) {
    console.log(
      "→ 事前の打ち切り基準（2%未満）を下回ったため、Step2（勝率比較）・Step3（backtest）は実施せず不採用とする。"
    );
  }

  await closeDb();
}

main();
