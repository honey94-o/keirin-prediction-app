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

function classifyBankLength(kyori: number, shukai: number): number | null {
  if (!shukai) return null;
  const perLap = kyori / shukai;
  // 標準的な周長は333m/400m/500m。誤差を見て最も近いものに丸める
  const candidates = [333, 400, 500];
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(perLap - c);
    if (diff < bestDiff && diff <= 20) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

async function main() {
  const db = getDb();

  // 開催場ごとに周長を推定（そのjocdの全レースの多数決）
  const raceRows = await db.execute(
    "SELECT id, jocd, keirinjo_name, kyori, shukai FROM races WHERE kyori IS NOT NULL AND shukai IS NOT NULL"
  );
  const races = raceRows.rows as unknown as {
    id: number;
    jocd: string;
    keirinjo_name: string;
    kyori: number;
    shukai: number;
  }[];

  const venueBankVotes = new Map<string, Map<number, number>>();
  const raceIdToBank = new Map<number, number>();
  for (const r of races) {
    const bank = classifyBankLength(r.kyori, r.shukai);
    if (bank == null) continue;
    raceIdToBank.set(r.id, bank);
    const votes = venueBankVotes.get(r.jocd) ?? new Map<number, number>();
    votes.set(bank, (votes.get(bank) ?? 0) + 1);
    venueBankVotes.set(r.jocd, votes);
  }

  console.log("開催場別の推定周長（多数決）:");
  const venueBank = new Map<string, number>();
  for (const [jocd, votes] of venueBankVotes) {
    const [bank] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    venueBank.set(jocd, bank);
    const name = races.find((r) => r.jocd === jocd)?.keirinjo_name ?? "?";
    console.log(`  ${name}(${jocd}): ${bank}m (${[...votes.entries()].map(([b, c]) => `${b}m×${c}`).join(", ")})`);
  }

  // 周長別の決まり手割合
  const kimariteRows = await db.execute(
    "SELECT race_id, kimarite FROM results WHERE finish_pos = 1 AND kimarite IS NOT NULL"
  );
  const kimariteByBank = new Map<number, Map<string, number>>();
  for (const row of kimariteRows.rows as unknown as { race_id: number; kimarite: string }[]) {
    const bank = raceIdToBank.get(row.race_id);
    if (bank == null) continue;
    const m = kimariteByBank.get(bank) ?? new Map<string, number>();
    m.set(row.kimarite, (m.get(row.kimarite) ?? 0) + 1);
    kimariteByBank.set(bank, m);
  }
  console.log("\n周長別の決まり手割合:");
  for (const [bank, m] of [...kimariteByBank.entries()].sort((a, b) => a[0] - b[0])) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const pct = (k: string) => (((m.get(k) ?? 0) / total) * 100).toFixed(1);
    console.log(`  ${bank}m: 母数${total} 逃${pct("逃")}% 捲${pct("捲")}% 差${pct("差")}% マ${pct("マ")}%`);
  }

  // 周長別の隊列内位置勝率
  const posRows = await db.execute(`
    SELECT e.race_id, e.line_position, r.finish_pos
    FROM entries e
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE e.line_position IS NOT NULL AND r.finish_pos IS NOT NULL
  `);
  const posByBank = new Map<number, Map<string, { entries: number; wins: number }>>();
  for (const row of posRows.rows as unknown as { race_id: number; line_position: string; finish_pos: number }[]) {
    const bank = raceIdToBank.get(row.race_id);
    if (bank == null) continue;
    const m = posByBank.get(bank) ?? new Map<string, { entries: number; wins: number }>();
    const b = m.get(row.line_position) ?? { entries: 0, wins: 0 };
    b.entries++;
    if (row.finish_pos === 1) b.wins++;
    m.set(row.line_position, b);
    posByBank.set(bank, m);
  }
  console.log("\n周長別の隊列内位置勝率:");
  for (const [bank, m] of [...posByBank.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  [${bank}m]`);
    for (const [pos, b] of m) {
      console.log(`    ${pos}: 出走${b.entries} 勝率${((b.wins / b.entries) * 100).toFixed(1)}%`);
    }
  }
}

main();
