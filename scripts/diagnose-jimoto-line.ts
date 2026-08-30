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
 * ユーザー提案「地元、ラインの構成（同県、即席ラインなど）」の検証。
 *
 * 1. 地元: racers.prefは選手単位の1行なので毎回上書きされ、レース単位の
 *    「（地元）」判定を過去に遡って再現できない（entries.prefは今日追加した
 *    ばかりでデータがまだ無い）。ただし選手の"基本府県"（地元サフィックスを
 *    除いた値）自体は選手が引退するまでほぼ変わらない安定した属性なので、
 *    現在のracers.prefスナップショットから基本府県を復元し、開催場の府県
 *    （jocd→都道府県の固定マッピング）と一致するかで「地元選手」を過去分も
 *    含めて判定できる。
 * 2. 同県ライン: 同じline_group内の選手の基本府県が全員（または過半数）
 *    同じ場合、ラインのワンツー率・先頭選手の勝率が変わるか。
 * 3. 即席ライン: 同じline_groupの選手ペアが、そのレースより前に何回
 *    同じラインを組んだ実績があるか（entries.line_groupの共起回数）を集計し、
 *    「初共演」ラインと「常連」ラインで成績が変わるか。
 */

// scripts/fetch-venue-coords.tsで使った開催場リストを流用し、都道府県を追加。
const JOCD_PREF: Record<string, string> = {
  "11": "北海道", "12": "青森", "13": "福島", "21": "新潟", "22": "群馬",
  "23": "茨城", "24": "栃木", "25": "埼玉", "26": "埼玉", "27": "東京",
  "28": "東京", "31": "千葉", "34": "神奈川", "35": "神奈川", "36": "神奈川",
  "37": "静岡", "38": "静岡", "42": "愛知", "43": "岐阜", "44": "岐阜",
  "45": "愛知", "46": "富山", "47": "三重", "48": "三重", "53": "奈良",
  "55": "和歌山", "56": "大阪", "61": "岡山", "62": "広島", "63": "山口",
  "73": "徳島", "74": "高知", "75": "愛媛", "81": "福岡", "83": "福岡",
  "84": "佐賀", "85": "長崎", "86": "大分", "87": "熊本",
};

function basePref(pref: string | null): string | null {
  if (!pref) return null;
  return pref.replace(/（地元）$/, "").trim();
}

async function main() {
  const db = getDb();

  // 選手の基本府県マップ（racers.prefから地元サフィックスを除去）
  const racersResult = await db.execute("SELECT snum, pref FROM racers WHERE pref IS NOT NULL");
  const prefBySnum = new Map<string, string>();
  for (const row of racersResult.rows as unknown as { snum: string; pref: string }[]) {
    const p = basePref(row.pref);
    if (p) prefBySnum.set(row.snum, p);
  }
  console.log(`選手の基本府県が判明: ${prefBySnum.size}名\n`);

  // 全出走データ（レース×選手、ラインと結果込み）
  const entriesResult = await db.execute(`
    SELECT e.race_id, ra.jocd, ra.kaisai_date, e.snum, e.car_num, e.line_group, e.line_position,
           r.finish_pos
    FROM entries e
    JOIN races ra ON ra.id = e.race_id
    JOIN results r ON r.race_id = e.race_id AND r.car_num = e.car_num
    WHERE r.finish_pos IS NOT NULL
    ORDER BY ra.kaisai_date, e.race_id
  `);
  type EntryRow = {
    race_id: number;
    jocd: string;
    kaisai_date: string;
    snum: string;
    car_num: number;
    line_group: number | null;
    line_position: string | null;
    finish_pos: number;
  };
  const entries = entriesResult.rows as unknown as EntryRow[];
  console.log(`結果確定済み出走: ${entries.length}件\n`);

  // ============ 1. 地元 ============
  let jimotoN = 0, jimotoWin = 0, jimotoTop3 = 0;
  let awayN = 0, awayWin = 0, awayTop3 = 0;
  for (const e of entries) {
    const pref = prefBySnum.get(e.snum);
    const venuePref = JOCD_PREF[e.jocd];
    if (!pref || !venuePref) continue;
    const isJimoto = pref === venuePref;
    if (isJimoto) {
      jimotoN++;
      if (e.finish_pos === 1) jimotoWin++;
      if (e.finish_pos <= 3) jimotoTop3++;
    } else {
      awayN++;
      if (e.finish_pos === 1) awayWin++;
      if (e.finish_pos <= 3) awayTop3++;
    }
  }
  console.log("■ 1. 地元選手の勝率:");
  console.log(
    `  地元: 勝率${((jimotoWin / jimotoN) * 100).toFixed(1)}% (${jimotoWin}/${jimotoN}) ` +
      `複勝率${((jimotoTop3 / jimotoN) * 100).toFixed(1)}%`
  );
  console.log(
    `  非地元: 勝率${((awayWin / awayN) * 100).toFixed(1)}% (${awayWin}/${awayN}) ` +
      `複勝率${((awayTop3 / awayN) * 100).toFixed(1)}%\n`
  );

  // ============ ライン単位の集計（1〜3着以内の実質ワンツー判定用） ============
  const byRaceLine = new Map<string, EntryRow[]>();
  for (const e of entries) {
    if (e.line_group == null) continue;
    const key = `${e.race_id}:${e.line_group}`;
    const arr = byRaceLine.get(key) ?? [];
    arr.push(e);
    byRaceLine.set(key, arr);
  }

  // ============ 2. 同県ライン ============
  let sameprefLines = 0, sameprefWantsu = 0, sameprefSenkoWin = 0, sameprefTotal = 0;
  let mixedLines = 0, mixedWantsu = 0, mixedSenkoWin = 0, mixedTotal = 0;
  for (const [, members] of byRaceLine) {
    if (members.length < 2) continue; // 単騎ラインは対象外
    const prefs = members.map((m) => prefBySnum.get(m.snum)).filter((p): p is string => !!p);
    if (prefs.length < members.length) continue; // 府県不明な選手が混ざる場合は除外
    const allSame = prefs.every((p) => p === prefs[0]);
    const senko = members.find((m) => m.line_position === "先頭");
    const top2CarNums = new Set(members.slice(0, 2).map((m) => m.car_num));
    // ワンツー判定: ライン内の（先頭+番手）の2人がレース全体の1-2着を占めたか
    const finishSet = new Set(members.map((m) => m.finish_pos));
    const isWantsu = finishSet.has(1) && finishSet.has(2) && members.some((m) => m.finish_pos === 1) && members.some((m) => m.finish_pos === 2);

    if (allSame) {
      sameprefLines++;
      sameprefTotal += members.length;
      if (isWantsu) sameprefWantsu++;
      if (senko && senko.finish_pos === 1) sameprefSenkoWin++;
    } else {
      mixedLines++;
      mixedTotal += members.length;
      if (isWantsu) mixedWantsu++;
      if (senko && senko.finish_pos === 1) mixedSenkoWin++;
    }
  }
  console.log("■ 2. 同県ライン vs 混成ライン:");
  console.log(
    `  同県ライン: ${sameprefLines}本 ワンツー率${((sameprefWantsu / sameprefLines) * 100).toFixed(1)}% ` +
      `先頭勝率${((sameprefSenkoWin / sameprefLines) * 100).toFixed(1)}%`
  );
  console.log(
    `  混成ライン: ${mixedLines}本 ワンツー率${((mixedWantsu / mixedLines) * 100).toFixed(1)}% ` +
      `先頭勝率${((mixedSenkoWin / mixedLines) * 100).toFixed(1)}%\n`
  );

  // ============ 3. 即席ライン vs 常連ライン（ペアの共起回数） ============
  // 日付順に処理し、「このレースより前に何回同じラインを組んだか」を選手ペアごとに積み上げる。
  const pairCoOccurrence = new Map<string, number>(); // "snumA|snumB" -> 過去の共起回数
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");

  const raceLineDates = [...byRaceLine.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => ({ key, members, date: members[0].kaisai_date }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let novice0 = { lines: 0, wantsu: 0, senkoWin: 0 };
  let novice1to3 = { lines: 0, wantsu: 0, senkoWin: 0 };
  let veteran4plus = { lines: 0, wantsu: 0, senkoWin: 0 };

  for (const { members } of raceLineDates) {
    // このラインの「馴染み度」= 全ペアの過去共起回数の平均
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i].snum, members[j].snum);
        pairSum += pairCoOccurrence.get(key) ?? 0;
        pairCount++;
      }
    }
    const familiarity = pairCount > 0 ? pairSum / pairCount : 0;

    const senko = members.find((m) => m.line_position === "先頭");
    const isWantsu =
      members.some((m) => m.finish_pos === 1) && members.some((m) => m.finish_pos === 2);

    const bucket = familiarity === 0 ? novice0 : familiarity <= 3 ? novice1to3 : veteran4plus;
    bucket.lines++;
    if (isWantsu) bucket.wantsu++;
    if (senko && senko.finish_pos === 1) bucket.senkoWin++;

    // 共起回数を更新（このレースの後の判定に反映されるよう、集計後に加算）
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i].snum, members[j].snum);
        pairCoOccurrence.set(key, (pairCoOccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  console.log("■ 3. ラインの「馴染み度」（ペアの過去共起回数の平均）別:");
  for (const [label, b] of [
    ["初共演(0回)", novice0],
    ["1-3回", novice1to3],
    ["4回以上(常連)", veteran4plus],
  ] as const) {
    console.log(
      `  ${label}: ${b.lines}本 ワンツー率${((b.wantsu / b.lines) * 100).toFixed(1)}% ` +
        `先頭勝率${((b.senkoWin / b.lines) * 100).toFixed(1)}%`
    );
  }
}

main();
