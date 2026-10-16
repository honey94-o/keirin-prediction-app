/**
 * DBクライアントを包んで、クエリ数・返却行数・返却バイト数を呼び出し元の関数別に数える。
 *
 * Neon無料枠の律速は「月5GBのネットワーク転送（DB→クライアントの送出）」なので、
 * 本番に一切つながずにローカルSQLite（scripts/lib/local-db.ts）上で同じ処理を回し、
 * どのクエリが何バイト返しているかを見積もるために使う（scripts/research/
 * measure-db-traffic.ts）。lib/db.ts を直接importせず引数で受け取るのは、
 * 変更前のコード一式（別ディレクトリに退避したもの）にも同じ計測を掛けるため。
 *
 * バイト数は2通り出す：
 *   - jsonBytes: 行をJSON化したUTF-8バイト数（列名を行ごとに含むので過大側）
 *   - wireBytes: Postgresのワイヤプロトコル（テキスト形式）で返る量の近似。
 *     RowDescription(列ごと約19B+列名) + DataRow(行ごと7B + 列ごと4B+値の文字列長)
 *     + CommandComplete/ReadyForQuery(約20B)。TLS等のオーバーヘッドは含めない。
 */
import type { DbClient, DbStatement, ExecuteResult } from "../../lib/db";

export interface TrafficStat {
  queries: number;
  rows: number;
  jsonBytes: number;
  wireBytes: number;
}

interface DbModuleLike {
  getDb(): DbClient;
  setDbClientForOfflineScripts(client: DbClient): void;
}

const emptyStat = (): TrafficStat => ({ queries: 0, rows: 0, jsonBytes: 0, wireBytes: 0 });

function valueText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  return JSON.stringify(v);
}

export function estimateWireBytes(rows: Record<string, unknown>[]): number {
  // 書き込み・空結果でもCommandComplete+ReadyForQueryは返る
  let bytes = 20;
  if (rows.length === 0) return bytes;
  const cols = Object.keys(rows[0]);
  bytes += 7 + cols.reduce((a, c) => a + Buffer.byteLength(c) + 1 + 18, 0);
  for (const row of rows) {
    bytes += 7;
    for (const c of cols) {
      const t = valueText(row[c]);
      bytes += 4 + (t == null ? 0 : Buffer.byteLength(t));
    }
  }
  return bytes;
}

// まとめ取り・まとめ書きの共通ヘルパー。これらの名前だけでは何のクエリか分からないのでSQLの表名を添える。
const GENERIC_HELPERS = new Set(["memoizedBySnum", "memoized", "upsertMany", "other"]);

/** スタックトレースから lib/repository.ts 内の呼び出し元関数名を取る（fetchXxx は getXxx に寄せる）。 */
function callerLabel(sql: string): string {
  const stack = new Error().stack ?? "";
  let fn = "other";
  for (const line of stack.split("\n")) {
    if (!/repository\.ts/.test(line) && !/accuracy\.ts/.test(line)) continue;
    const m = /at (?:async )?(?:Object\.)?([A-Za-z0-9_$]+) \(/.exec(line);
    if (m) {
      fn = m[1].replace(/^fetch/, "get");
      break;
    }
  }
  if (!GENERIC_HELPERS.has(fn)) return fn;
  const t = /^\s*insert\s+into\s+(\w+)/i.exec(sql) ?? /\bfrom\s+(\w+)/i.exec(sql);
  return `${fn}[${t?.[1] ?? "?"}]`;
}

export interface TrafficMeter {
  stats: Map<string, TrafficStat>;
  reset(): void;
  total(): TrafficStat;
  report(title: string, opts?: { top?: number; divideBy?: number }): string;
}

export function installTrafficMeter(dbModule: DbModuleLike): TrafficMeter {
  const inner = dbModule.getDb();
  const stats = new Map<string, TrafficStat>();
  const record = (label: string, result: ExecuteResult) => {
    const s = stats.get(label) ?? emptyStat();
    const rows = result.rows as Record<string, unknown>[];
    s.queries++;
    s.rows += rows.length;
    s.jsonBytes += rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0;
    s.wireBytes += estimateWireBytes(rows);
    stats.set(label, s);
  };
  const client: DbClient = {
    execute: (async (stmtOrSql: string | DbStatement, args?: unknown[]) => {
      const label = callerLabel(typeof stmtOrSql === "string" ? stmtOrSql : stmtOrSql.sql);
      const result =
        typeof stmtOrSql === "string" ? await inner.execute(stmtOrSql, args ?? []) : await inner.execute(stmtOrSql);
      record(label, result);
      return result;
    }) as DbClient["execute"],
    batch: async (statements: DbStatement[]) => {
      const label = callerLabel(statements[0]?.sql ?? "");
      const results = await inner.batch(statements);
      // Postgres版のbatchはBEGIN/COMMITを含めて文の数だけ往復する
      for (const r of results) record(label, r);
      record(label, { rows: [] });
      record(label, { rows: [] });
      return results;
    },
  };
  dbModule.setDbClientForOfflineScripts(client);

  const total = () => {
    const t = emptyStat();
    for (const s of stats.values()) {
      t.queries += s.queries;
      t.rows += s.rows;
      t.jsonBytes += s.jsonBytes;
      t.wireBytes += s.wireBytes;
    }
    return t;
  };
  const kb = (b: number) => `${(b / 1024).toFixed(1)}KB`;
  return {
    stats,
    reset: () => stats.clear(),
    total,
    report(title, opts = {}) {
      const div = opts.divideBy ?? 1;
      const t = total();
      const lines = [
        `== ${title}${div !== 1 ? `（${div}件あたり）` : ""}: queries=${(t.queries / div).toFixed(1)} rows=${(t.rows / div).toFixed(0)} ` +
          `wire≈${kb(t.wireBytes / div)} json=${kb(t.jsonBytes / div)}`,
      ];
      const sorted = [...stats.entries()].sort((a, b) => b[1].wireBytes - a[1].wireBytes).slice(0, opts.top ?? 20);
      for (const [label, s] of sorted) {
        lines.push(
          `   ${label.padEnd(36)} q=${String(+(s.queries / div).toFixed(1)).padStart(7)} rows=${String(Math.round(s.rows / div)).padStart(7)} ` +
            `wire≈${kb(s.wireBytes / div).padStart(10)} (${((s.wireBytes / Math.max(1, t.wireBytes)) * 100).toFixed(1)}%)`
        );
      }
      return lines.join("\n");
    },
  };
}
