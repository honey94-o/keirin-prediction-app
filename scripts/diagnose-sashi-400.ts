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

// 前回の集計（周長混在・中央値56.9mで2分割）では直線長による差が見えなかったが、
// 周長そのもの（バンクの規模・カーブのきつさ等）が交絡している可能性がある。
// 周長400mの開催場だけに絞り、実測直線距離で「①1着決まり手が差しになる割合
// （バンク全体の傾向） ②差し回数6以上の選手の勝率」の両方を見る。

function classifyBankLength(kyori: number, shukai: number): number | null {
  if (!shukai) return null;
  const perLap = kyori / shukai;
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

function parseTyokusenMeters(tyokusen: string | null): number | null {
  if (!tyokusen) return null;
  const m = /([\d.]+)/.exec(tyokusen);
  return m ? Number(m[1]) : null;
}

const SASHI_THRESHOLD = 6;

async function main() {
  const db = getDb();

  // 開催場ごとの周長を多数決で判定
  const raceRows = await db.execute(
    "SELECT id, jocd, kyori, shukai FROM races WHERE kyori IS NOT NULL AND shukai IS NOT NULL"
  );
  const races = raceRows.rows as unknown as { id: number; jocd: string; kyori: number; shukai: number }[];
  const venueBankVotes = new Map<string, Map<number, number>>();
  for (const r of races) {
    const bank = classifyBankLength(r.kyori, r.shukai);
    if (bank == null) continue;
    const votes = venueBankVotes.get(r.jocd) ?? new Map<number, number>();
    votes.set(bank, (votes.get(bank) ?? 0) + 1);
    venueBankVotes.set(r.jocd, votes);
  }
  const venueBank = new Map<string, number>();
  for (const [jocd, votes] of venueBankVotes) {
    const [bank] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    venueBank.set(jocd, bank);
  }

  // 周長400mの開催場だけ抽出し、実測直線距離を付与
  const bankRows = await db.execute("SELECT jocd, keirinjo_name, tyokusen FROM bank_info WHERE tyokusen IS NOT NULL");
  const banks = bankRows.rows as unknown as { jocd: string; keirinjo_name: string; tyokusen: string }[];
  const venue400 = banks
    .filter((b) => venueBank.get(b.jocd) === 400)
    .map((b) => ({ jocd: b.jocd, name: b.keirinjo_name, length: parseTyokusenMeters(b.tyokusen)! }))
    .filter((v) => v.length != null)
    .sort((a, b) => a.length - b.length);

  console.log(`=== 周長400mの開催場: ${venue400.length}場（直線距離順） ===`);
  for (const v of venue400) console.log(`  ${v.name}: 直線${v.length}m`);

  const median400 = venue400[Math.floor(venue400.length / 2)].length;
  console.log(`\n400m帯での直線距離の中央値: ${median400}m`);

  const jocd400 = new Set(venue400.map((v) => v.jocd));
  const lengthByJocd = new Map(venue400.map((v) => [v.jocd, v.length]));

  // ① 400m帯の中で、1着決まり手が「差」になる割合（開催場ごと・長い/短いグループごと）
  const kimariteRows = await db.execute(`
    SELECT ra.jocd, res.kimarite
    FROM results res
    JOIN races ra ON ra.id = res.race_id
    WHERE res.finish_pos = 1 AND res.kimarite IS NOT NULL
  `);
  const kimariteData = kimariteRows.rows as unknown as { jocd: string; kimarite: string }[];
  type KAgg = { total: number; sashi: number };
  const kByGroup = new Map<string, KAgg>();
  const kByVenue = new Map<string, KAgg>();
  for (const row of kimariteData) {
    if (!jocd400.has(row.jocd)) continue;
    const length = lengthByJocd.get(row.jocd)!;
    const group = length >= median400 ? "直線長い" : "直線短い";
    const gAgg = kByGroup.get(group) ?? { total: 0, sashi: 0 };
    gAgg.total += 1;
    if (row.kimarite === "差") gAgg.sashi += 1;
    kByGroup.set(group, gAgg);

    const vAgg = kByVenue.get(row.jocd) ?? { total: 0, sashi: 0 };
    vAgg.total += 1;
    if (row.kimarite === "差") vAgg.sashi += 1;
    kByVenue.set(row.jocd, vAgg);
  }

  console.log(`\n=== ①400m帯・直線長短別：1着決まり手が「差」の割合 ===`);
  for (const group of ["直線短い", "直線長い"]) {
    const agg = kByGroup.get(group);
    if (!agg) continue;
    console.log(`  ${group}: 母数${agg.total} 差${agg.sashi}件 割合${((agg.sashi / agg.total) * 100).toFixed(1)}%`);
  }
  console.log(`\n  開催場別内訳（直線距離順）:`);
  for (const v of venue400) {
    const agg = kByVenue.get(v.jocd);
    if (!agg) continue;
    console.log(`    ${v.name}(直線${v.length}m): 母数${agg.total} 差割合${((agg.sashi / agg.total) * 100).toFixed(1)}%`);
  }

  // ② 400m帯の中で、選手個人の差し回数6以上/未満の勝率
  const rows = await db.execute(`
    SELECT e.race_id, ra.jocd, r.kimarite_sashi_count, res.finish_pos
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN racers r ON r.snum = e.snum
    JOIN results res ON res.race_id = e.race_id AND res.car_num = e.car_num
    WHERE res.finish_pos IS NOT NULL AND r.kimarite_sashi_count IS NOT NULL
  `);
  const data = rows.rows as unknown as {
    race_id: number;
    jocd: string;
    kimarite_sashi_count: number;
    finish_pos: number;
  }[];
  type Agg = { total: number; wins: number };
  const table = new Map<string, Agg>();
  for (const row of data) {
    if (!jocd400.has(row.jocd)) continue;
    const length = lengthByJocd.get(row.jocd)!;
    const group = length >= median400 ? "直線長い" : "直線短い";
    const bucket = row.kimarite_sashi_count >= SASHI_THRESHOLD ? `差し${SASHI_THRESHOLD}以上` : `差し${SASHI_THRESHOLD}未満`;
    const key = `${group}_${bucket}`;
    const agg = table.get(key) ?? { total: 0, wins: 0 };
    agg.total += 1;
    if (row.finish_pos === 1) agg.wins += 1;
    table.set(key, agg);
  }
  console.log(`\n=== ②400m帯・直線長短別：選手の差し回数(${SASHI_THRESHOLD}以上/未満)別 勝率 ===`);
  for (const group of ["直線短い", "直線長い"]) {
    for (const bucket of [`差し${SASHI_THRESHOLD}以上`, `差し${SASHI_THRESHOLD}未満`]) {
      const key = `${group}_${bucket}`;
      const agg = table.get(key);
      if (!agg) continue;
      console.log(`  ${group} × ${bucket}: 母数${agg.total} 勝利${agg.wins} 勝率${((agg.wins / agg.total) * 100).toFixed(1)}%`);
    }
  }
}

main();
