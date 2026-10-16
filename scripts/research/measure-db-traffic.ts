/**
 * DB転送量（Neon無料枠の律速＝月5GBの送出）の見積もり。本番には一切つながず、
 * ローカルSQLiteの一時コピーに対して実際のスクリプト／predictRaceを回し、
 * クエリ数・返却行数・返却バイト数（Postgresワイヤ形式の近似、scripts/lib/db-traffic-meter.ts）を
 * 呼び出し元の関数別に出す。
 *
 * 使い方:
 *   # 日次スクリプトをJSTの指定時刻に実行した場合（例: 朝5時のcompute-picks）
 *   npx tsx scripts/research/measure-db-traffic.ts script scripts/compute-picks.ts 2026-10-14T05:00
 *   npx tsx scripts/research/measure-db-traffic.ts script scripts/daily-summary.ts 2026-10-15T05:00
 *   # レースページ1回の表示（predictRace 1回、キャッシュ無し）を変更前の経路と比較
 *   npx tsx scripts/research/measure-db-traffic.ts page-view [YYYYMMDD]
 *
 * script モードはDBの一時コピーに書き込むので、2回目以降の実行状態（保存済みの予想が
 * ある朝など）を測りたい場合は同じコピーを使い回せるよう --db <path> を指定する。
 */
import { copyFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 万一どこかで本番接続が試みられても失敗するよう、存在しない接続先で上書きしておく
// （各スクリプトの.env.local読み込みは既に設定済みのキーを上書きしない）。
process.env.DATABASE_URL = "postgres://offline@127.0.0.1:9/offline";
process.env.POSTGRES_URL = "postgres://offline@127.0.0.1:9/offline";
process.env.POSTGRES_PRISMA_URL = "postgres://offline@127.0.0.1:9/offline";

// useXxxという名前だとReactフックと誤認するlintルールがあるため別名で使う
import { useLocalDb as attachLocalDb, LOCAL_DB_PATH } from "../lib/local-db";
import * as dbModule from "../../lib/db";
import { installTrafficMeter } from "../lib/db-traffic-meter";

async function runScript(script: string, jst: string, rest: string[]) {
  const dbIdx = rest.indexOf("--db");
  const keepDb = dbIdx >= 0 ? rest[dbIdx + 1] : null;
  const scriptArgs = dbIdx >= 0 ? rest.filter((_, i) => i !== dbIdx && i !== dbIdx + 1) : rest;
  const dbPath = keepDb ?? path.join(os.tmpdir(), `keirin-measure-${process.pid}.sqlite`);
  if (!keepDb) copyFileSync(LOCAL_DB_PATH, dbPath);
  const sqlite = attachLocalDb(dbPath);
  const meter = installTrafficMeter(dbModule);

  const realNow = Date.now.bind(Date);
  const base = Date.parse(`${jst}:00+09:00`);
  const start = realNow();
  Date.now = () => base + (realNow() - start);
  process.argv = [process.argv[0], path.resolve(script), ...scriptArgs];
  process.on("beforeExit", () => {
    console.log(`\n[計測] ${realNow() - start}ms（ローカルSQLite。Neonでは往復ごとの待ちが加わる）`);
    console.log(meter.report(`${script} @ JST ${jst}`));
    sqlite.close();
    if (!keepDb) rmSync(dbPath, { force: true });
    process.exit(0);
  });
  await import(pathToFileURL(path.resolve(script)).href);
}

async function pageView(date: string | undefined) {
  const sqlite = attachLocalDb();
  const { predictRace } = await import("../../lib/predict");
  const { getRacesByDate } = await import("../../lib/repository");
  const { legacyPredictRace } = await import("./lib/legacy-predict");
  const d =
    date ?? (sqlite.prepare("SELECT MAX(kaisai_date) AS d FROM races").get() as { d: string }).d;
  const races = await getRacesByDate(d);
  const meter = installTrafficMeter(dbModule);
  for (const r of races) await legacyPredictRace(r.id);
  console.log(meter.report(`変更前のpredictRace（${d}・${races.length}レース）`, { divideBy: races.length, top: 12 }));
  meter.reset();
  for (const r of races) await predictRace(r.id);
  console.log(meter.report(`現在のpredictRace（${d}・${races.length}レース）`, { divideBy: races.length, top: 12 }));
  sqlite.close();
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "script" && args.length >= 2) {
  runScript(args[0], args[1], args.slice(2));
} else if (mode === "page-view") {
  pageView(args[0]);
} else {
  console.error("usage: measure-db-traffic.ts script <scripts/xxx.ts> <JST 2026-10-14T05:00> [--db path] [args] | page-view [YYYYMMDD]");
  process.exit(1);
}
