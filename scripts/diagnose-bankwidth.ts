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
 * バンクの幅員（home_hukuin等）は31開催場すべてでデータがあるのに
 * calculateBankFitScoreでは一度も使われていない（nige_pct/makuri_pct/sashi_pct
 * という実績決まり手割合のみ使用）。幅員が広いほど外から差す/捲る余地が
 * あり、まくり・差しが決まりやすいのでは、という仮説を検証する。
 * ただし開催場は31場のみで多重比較・少数サンプルのリスクが七番目の発見
 * （直線距離）や九番目の発見（開催場フィルタ）と同様にあるため、
 * バケットは少数（中央値2分割）に留め、参考程度として扱う。
 */

function parseMeters(s: string | null): number | null {
  if (!s) return null;
  const m = /([\d.]+)m/.exec(s);
  return m ? Number(m[1]) : null;
}

async function main() {
  const db = getDb();
  const banks = await db.execute(
    `SELECT jocd, keirinjo_name, home_hukuin, back_hukuin, center_hukuin, shuutyou FROM bank_info`
  );
  type BankRow = {
    jocd: string;
    keirinjo_name: string;
    home_hukuin: string | null;
    back_hukuin: string | null;
    center_hukuin: string | null;
    shuutyou: number | null;
  };
  const bankRows = banks.rows as unknown as BankRow[];
  const widthByJocd = new Map<string, number>();
  for (const b of bankRows) {
    const home = parseMeters(b.home_hukuin);
    const back = parseMeters(b.back_hukuin);
    const center = parseMeters(b.center_hukuin);
    const vals = [home, back, center].filter((v): v is number => v != null);
    if (vals.length === 0) continue;
    widthByJocd.set(b.jocd, vals.reduce((a, c) => a + c, 0) / vals.length);
  }
  console.log(`幅員データがある開催場: ${widthByJocd.size}場`);
  const widths = [...widthByJocd.values()].sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  console.log(`幅員（3線平均）の中央値: ${median.toFixed(2)}m（範囲 ${widths[0].toFixed(1)}〜${widths[widths.length - 1].toFixed(1)}m）`);

  // 出走ごとに、その開催場の幅員区分×決まり手（勝ったときのkimarite）を集計
  const entriesResult = await db.execute(`
    SELECT ra.jocd, r.finish_pos, r.kimarite
    FROM results r
    JOIN races ra ON ra.id = r.race_id
    WHERE r.finish_pos = 1 AND r.kimarite IS NOT NULL
  `);
  type Row = { jocd: string; finish_pos: number; kimarite: string };
  const rows = entriesResult.rows as unknown as Row[];
  console.log(`1着決まり手データ: ${rows.length}件\n`);

  const byWidthBucket = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const width = widthByJocd.get(r.jocd);
    if (width == null) continue;
    const bucket = width >= median ? "広い(中央値以上)" : "狭い(中央値未満)";
    const m = byWidthBucket.get(bucket) ?? new Map<string, number>();
    m.set(r.kimarite, (m.get(r.kimarite) ?? 0) + 1);
    byWidthBucket.set(bucket, m);
  }

  console.log("■ バンク幅員区分別 1着決まり手の内訳:");
  for (const bucket of ["狭い(中央値未満)", "広い(中央値以上)"]) {
    const m = byWidthBucket.get(bucket);
    if (!m) continue;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const parts = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kimarite, c]) => `${kimarite}${((c / total) * 100).toFixed(1)}%`)
      .join(" / ");
    console.log(`  ${bucket}(n=${total}): ${parts}`);
  }
}

main();
