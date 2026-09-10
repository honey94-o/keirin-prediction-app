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
 * 【検証結果: 弱いが交絡ではない実シグナル。単独ではROI寄与が小さく保留】
 * 前検日インタビュー本文（racer_interviews.answer）が、既存の強さ指標では
 * 拾えない「その日の調子」を予測に足せるか検証する。
 *
 * これまでpre_race_comment（一言）とgear_ratioを試したが、いずれも
 * heikin_tokuten/line_positionとの交絡で不採用だった。インタビュー本文は
 * 「調子は良くない」「落車明けで練習できていない」など、静的属性が
 * 反映するより前の当日情報を含むため、別筋になりうる。
 *
 * 交絡対策: レース内をheikin_tokutenで順位付けした「紙面順位」で層別し、
 * 同じ紙面評価の選手同士で、ネガ発言あり vs なし の成績を比べる。
 *
 * 結果（紙面順位で層別済み＝交絡なし、train/testとも再現）:
 *   ・紙面1番手がネガ発言（全体の3.7%）: 3着内率 77.5%→74.8%（-2.7pt）。
 *     勝率はほぼ不変（42.3%→41.2%）。train 75.0% / test 74.6%で安定。
 *   ・その同じレースの紙面2番手: 勝率 22.8%→24.9%（+2.1pt）、
 *     3着内率 64.2%→66.8%（+2.6pt）。train/testとも同方向。
 *   ・紙面2番手以下ではネガ発言に効果なし（ノイズ or 逆方向）。
 *   ・ネガを「練習不足」「調子言及のみ」に細分化すると各n<300で
 *     train/testが逆転。細かい分類は過学習。
 *   ・ポジ発言は紙面4番手以下の3着内率を+3ptだが弱く、実用度低い。
 *
 * 交絡由来ではない初めての結果だが、効果量が2〜3ptと小さく対象レースも
 * 全体の4%程度。単独採用では回収率をほぼ動かせない見込みのため、
 * 「本命がネガ発言のレースを厳選から除外」等の使い方をバックテストで
 * 確かめた上で判断する（未実施）。
 */

// 「調子・状態が良くない」系（二重否定・回復表現は除外）
const NEG_CONDITION =
  /(調子|状態|体調|感じ|具合)[^。]{0,14}(良くな|よくな|悪い|上がら|上がって(こ|き)?な|イマイチ|いまいち|パッとしな|良いとは言えな|下降|最悪|最低)/;
const NEG_PRACTICE = /(練習|調整|乗り込み|乗り込め)[^。]{0,12}(でき(て)?い?な|出来(て)?い?な|不足)|練習不足/;
const NEG_EXCLUDE = /(悪いわけでは|悪くはな|悪くな|問題な|影響はな|不安はな|心配な(い|さそう))/;

// 「調子・状態が良い／自信あり」系
const POS_CONDITION =
  /(調子|状態|体調|感じ|具合|仕上がり)[^。]{0,14}(いい|良い|上向き|上がって(き|る)|戻って(き|る)|バッチリ|絶好調|悪くない|上々)/;
const POS_CONFIDENCE = /自信[^。]{0,6}(が)?あ(る|り)|手応え[^。]{0,8}(が)?あ(る|り)|絶好調|バッチリ/;

type Row = {
  race_id: number;
  snum: string;
  kaisai_date: string;
  tokuten_rank: number;
  finish_pos: number | null;
  answers: string | null;
};

function classify(text: string | null): "neg" | "pos" | "neutral" {
  if (!text) return "neutral";
  const neg = (NEG_CONDITION.test(text) || NEG_PRACTICE.test(text)) && !NEG_EXCLUDE.test(text);
  const pos = POS_CONDITION.test(text) || POS_CONFIDENCE.test(text);
  if (neg && !pos) return "neg";
  if (pos && !neg) return "pos";
  return "neutral";
}

async function main() {
  const db = getDb();
  const res = await db.execute(`
    WITH ranked AS (
      SELECT e.race_id, e.snum, e.car_num, ra.kaisai_date,
        RANK() OVER (PARTITION BY e.race_id ORDER BY rc.heikin_tokuten DESC NULLS LAST) AS tokuten_rank
      FROM entries e
      JOIN races ra ON ra.id = e.race_id
      JOIN racers rc ON rc.snum = e.snum
      WHERE ra.encp LIKE 'wt:%' AND rc.heikin_tokuten IS NOT NULL
    )
    SELECT rk.race_id, rk.snum, rk.kaisai_date, rk.tokuten_rank, r.finish_pos,
      (SELECT string_agg(ri.answer, ' ') FROM racer_interviews ri
        WHERE ri.race_id = rk.race_id AND ri.snum = rk.snum) AS answers
    FROM ranked rk
    LEFT JOIN results r ON r.race_id = rk.race_id AND r.car_num = rk.car_num
    ORDER BY rk.kaisai_date
  `);
  const rows = res.rows as unknown as Row[];

  type Rec = {
    tokutenRank: number;
    cat: "neg" | "pos" | "neutral";
    win: boolean;
    rentai: boolean;
    kaisaiDate: string;
  };
  const recs: Rec[] = rows
    .filter((r) => r.finish_pos != null)
    .map((r) => ({
      tokutenRank: r.tokuten_rank,
      cat: classify(r.answers),
      win: r.finish_pos === 1,
      rentai: (r.finish_pos as number) <= 3,
      kaisaiDate: r.kaisai_date,
    }));

  const total = recs.length;
  const negN = recs.filter((r) => r.cat === "neg").length;
  const posN = recs.filter((r) => r.cat === "pos").length;
  console.log(
    `対象: ${total}件（インタビューあり出走）  neg=${negN}（${((negN / total) * 100).toFixed(1)}%） pos=${posN}（${((posN / total) * 100).toFixed(1)}%）\n`
  );

  function stats(data: Rec[]): string {
    if (data.length === 0) return "-";
    const w = (data.filter((r) => r.win).length / data.length) * 100;
    const re = (data.filter((r) => r.rentai).length / data.length) * 100;
    return `勝率${w.toFixed(1)}% 3着内${re.toFixed(1)}%(n=${data.length})`;
  }

  const dates = [...new Set(recs.map((r) => r.kaisaiDate))].sort();
  const split = dates[Math.floor(dates.length * (2 / 3))];
  console.log(`train=${dates[0]}〜 / test=${split}〜${dates.at(-1)}\n`);

  for (const band of [
    { label: "紙面1番手", test: (r: Rec) => r.tokutenRank === 1 },
    { label: "紙面2-3番手", test: (r: Rec) => r.tokutenRank >= 2 && r.tokutenRank <= 3 },
    { label: "紙面4番手以下", test: (r: Rec) => r.tokutenRank >= 4 },
  ]) {
    const inBand = recs.filter(band.test);
    for (const cat of ["neg", "neutral", "pos"] as const) {
      const d = inBand.filter((r) => r.cat === cat);
      const tr = d.filter((r) => r.kaisaiDate < split);
      const te = d.filter((r) => r.kaisaiDate >= split);
      console.log(
        `[${band.label}] ${cat.padEnd(7)} 全体 ${stats(d)}  | train ${stats(tr)} | test ${stats(te)}`
      );
    }
    console.log("");
  }

  // 「neg」を細分化: 練習不足（具体的・行動的）と 調子言及のみ（謙遜の可能性）
  console.log("=== 紙面1番手のneg細分化 ===");
  const fav = recs.filter((r) => r.tokutenRank === 1);
  const favRows = rows.filter((r) => r.finish_pos != null && r.tokuten_rank === 1);
  const byKey = new Map(favRows.map((r) => [`${r.race_id}:${r.snum}`, r.answers ?? ""]));
  function subcat(rec: Rec, raceKey: string): string {
    const t = byKey.get(raceKey) ?? "";
    const practice = NEG_PRACTICE.test(t) && !NEG_EXCLUDE.test(t);
    const cond = NEG_CONDITION.test(t) && !NEG_EXCLUDE.test(t);
    if (practice) return "練習不足";
    if (cond) return "調子言及のみ";
    return "-";
  }
  // recとrowを対応付け（同順・同フィルタなのでインデックス対応は崩れているため再JOIN）
  const favWithKey = favRows.map((r) => ({
    rec: {
      tokutenRank: 1,
      cat: classify(r.answers),
      win: r.finish_pos === 1,
      rentai: (r.finish_pos as number) <= 3,
      kaisaiDate: r.kaisai_date,
    } as Rec,
    key: `${r.race_id}:${r.snum}`,
  }));
  for (const sc of ["練習不足", "調子言及のみ"]) {
    const d = favWithKey.filter((x) => x.rec.cat === "neg" && subcat(x.rec, x.key) === sc).map((x) => x.rec);
    const tr = d.filter((r) => r.kaisaiDate < split);
    const te = d.filter((r) => r.kaisaiDate >= split);
    console.log(`  ${sc.padEnd(8)} 全体 ${stats(d)} | train ${stats(tr)} | test ${stats(te)}`);
  }
  void fav;

  // 本命がnegの時、そのレースの紙面2番手は得をするか
  console.log("\n=== 紙面1番手がneg の時、紙面2番手の成績 ===");
  const favCatByRace = new Map<number, "neg" | "pos" | "neutral">();
  for (const r of rows) {
    if (r.tokuten_rank === 1) favCatByRace.set(r.race_id, classify(r.answers));
  }
  const rank2 = rows
    .filter((r) => r.finish_pos != null && r.tokuten_rank === 2)
    .map((r) => ({
      favNeg: favCatByRace.get(r.race_id) === "neg",
      win: r.finish_pos === 1,
      rentai: (r.finish_pos as number) <= 3,
      kaisaiDate: r.kaisai_date,
      tokutenRank: 2,
      cat: "neutral" as const,
    }));
  for (const [label, pred] of [
    ["本命neg時", (r: (typeof rank2)[number]) => r.favNeg],
    ["本命neg以外", (r: (typeof rank2)[number]) => !r.favNeg],
  ] as const) {
    const d = rank2.filter(pred);
    const tr = d.filter((r) => r.kaisaiDate < split);
    const te = d.filter((r) => r.kaisaiDate >= split);
    console.log(`  紙面2番手 ${label.padEnd(10)} 全体 ${stats(d)} | train ${stats(tr)} | test ${stats(te)}`);
  }
}

main();
