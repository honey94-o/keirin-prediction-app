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
import { todayJstStr, addDaysToDateStr } from "../lib/date";

/**
 * DBを直近RETENTION_DAYS日分のローリングウィンドウに保つため、それより古いレースを
 * races（および紐づくentries/results/odds/predictions/daily_picks）から削除する。
 *
 * 注意：schema.sqlの各テーブルはrace_idにON DELETE CASCADEを付けているが、
 * このアプリはどこでもPRAGMA foreign_keys=ONを実行していない（SQLiteはデフォルトで
 * 外部キー制約オフ）。さらにTurso（HTTP経由）は1リクエストごとに接続が切れるため、
 * 仮にPRAGMAを立てても次のexecute()に持ち越される保証がない。そのためカスケードに
 * 頼らず、子テーブル→races の順に明示的にDELETEする。
 *
 * デフォルトはdry-run（削除件数を表示するだけ）。実際に削除するには--executeを付ける。
 */
const RETENTION_DAYS = 120;

function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const cutoff = addDaysToDateStr(todayJstStr(), -RETENTION_DAYS);
  const db = getDb();

  const rows = await db.execute({
    sql: "SELECT id FROM races WHERE kaisai_date < ?",
    args: [cutoff],
  });
  const raceIds = (rows.rows as unknown as { id: number }[]).map((r) => r.id);

  console.log(`保持期間: 直近${RETENTION_DAYS}日（カットオフ日: ${cutoff}より前を削除）`);
  console.log(`削除対象レース数: ${raceIds.length}件`);

  if (raceIds.length === 0) {
    console.log("削除対象なし。何もしません。");
    return;
  }

  if (!execute) {
    console.log("(dry-run。実際に削除するには --execute を付けて実行してください)");
    return;
  }

  const childTables = ["predictions", "daily_picks", "odds", "results", "entries"];
  for (const ids of chunk(raceIds)) {
    const placeholders = ids.map(() => "?").join(",");
    for (const table of childTables) {
      await db.execute({ sql: `DELETE FROM ${table} WHERE race_id IN (${placeholders})`, args: ids });
    }
    await db.execute({ sql: `DELETE FROM races WHERE id IN (${placeholders})`, args: ids });
  }
  console.log(`削除完了: ${raceIds.length}レース分（entries/results/odds/predictions/daily_picksも合わせて削除）`);
}

main();
