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
 * バンクの傾斜角度（kant=カント、コーナー部の路面傾斜。tkant=直線部の傾斜）は
 * 31開催場すべてでデータがあるのに一度も使われていない（幅員=hukuinは
 * diagnose-bankwidth.tsで検証済み・効果なし、これは別の未検証ジオメトリ）。
 * カントが急なほどコーナーで速度を落とさず走れる＝差し・捲りが決まりやすい
 * のでは、という仮説を検証する。開催場は31場のみで多重比較・少数サンプルの
 * リスクがあるため中央値2分割に留め、参考程度として扱う。
 */

function parseDegrees(s: string | null): number | null {
  if (!s) return null;
  const decoded = s.replace(/&deg;/g, "°").replace(/&prime;/g, "'").replace(/&Prime;/g, '"');
  const m = /(\d+)°\s*(\d+)?'?\s*(\d+)?"?/.exec(decoded);
  if (!m) return null;
  const deg = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  return deg + min / 60 + sec / 3600;
}

async function main() {
  const db = getDb();
  const banks = await db.execute(`SELECT jocd, keirinjo_name, kant, tkant FROM bank_info`);
  type BankRow = { jocd: string; keirinjo_name: string; kant: string | null; tkant: string | null };
  const bankRows = banks.rows as unknown as BankRow[];

  const kantByJocd = new Map<string, number>();
  for (const b of bankRows) {
    const deg = parseDegrees(b.kant);
    if (deg != null) kantByJocd.set(b.jocd, deg);
  }
  console.log(`カント角度データがある開催場: ${kantByJocd.size}場`);
  const kants = [...kantByJocd.values()].sort((a, b) => a - b);
  const median = kants[Math.floor(kants.length / 2)];
  console.log(`カント角度の中央値: ${median.toFixed(2)}°（範囲 ${kants[0].toFixed(1)}〜${kants[kants.length - 1].toFixed(1)}°）`);

  const entriesResult = await db.execute(`
    SELECT ra.jocd, r.finish_pos, r.kimarite
    FROM results r
    JOIN races ra ON ra.id = r.race_id
    WHERE r.finish_pos = 1 AND r.kimarite IS NOT NULL
  `);
  type Row = { jocd: string; finish_pos: number; kimarite: string };
  const rows = entriesResult.rows as unknown as Row[];
  console.log(`1着決まり手データ: ${rows.length}件\n`);

  const byBucket = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const kant = kantByJocd.get(r.jocd);
    if (kant == null) continue;
    const bucket = kant >= median ? "急(中央値以上)" : "緩やか(中央値未満)";
    const m = byBucket.get(bucket) ?? new Map<string, number>();
    m.set(r.kimarite, (m.get(r.kimarite) ?? 0) + 1);
    byBucket.set(bucket, m);
  }

  console.log("■ カント角度区分別 1着決まり手の内訳:");
  for (const bucket of ["緩やか(中央値未満)", "急(中央値以上)"]) {
    const m = byBucket.get(bucket);
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
