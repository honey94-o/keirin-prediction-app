/**
 * 取得経路の最適化（2026-10）で予想・ピックの出力が1バイトも変わっていないことの検証。
 * 本番DBには一切つながず、ローカルSQLite（scripts/data/local.sqlite）の一時コピーで回す。
 *
 * 比較するもの（いずれも JSON.stringify の完全一致）:
 *  1. predictRace：変更前の経路（scripts/research/lib/legacy-predict.ts、選手ごと1クエリ・
 *     全履歴・単騎/上がりも取得）と、新経路のキャッシュ無し（=Next.jsのページ表示と同じ）
 *  2. 2・3着モデル用履歴：全履歴（変更前）と直近20走∪120日窓（新）で computeForm が同一か
 *  3. compute-picks相当：当日（05:00/12:00/19:00時点で未発走のレースだけ）→翌日の順に
 *     先読み（前日分からの差分合成を含む）＋predictRaceを回し、予想と厳選/バリカタ/
 *     候補漏れ/中穴の各ピック（買い目・margin）が変更前の全レース計算と一致するか、
 *     ピック対象のレース集合が「変更前のピック ∩ 未発走レース」と一致するか
 *  4. daily-summary相当：予想未保存の結果確定レースだけを7日分保存→predictionsの各行が
 *     変更前の予想と一致するか、翌日の再実行で保存済みの行に触れないか
 *
 * 使い方: npx tsx scripts/research/verify-fetch-optimization.ts [--all]
 *   既定は約2週間おきの日付とその翌日（連日の差分合成を通すため）＋直近2日。--allで全日付。
 */
import { copyFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// useXxxという名前だとReactフックと誤認するlintルールがあるため別名で使う
import { useLocalDb as attachLocalDb, LOCAL_DB_PATH } from "../lib/local-db";
import { predictRace, prefetchRaceInputs, type RacePrediction } from "../../lib/predict";
import {
  clearReadCache,
  enableReadCache,
  getPitHistories,
  getRacesByDate,
  getRacesWithoutPrediction,
  getResultsForRaces,
  savePredictions,
} from "../../lib/repository";
import { getDb } from "../../lib/db";
import { addDaysToDateStr } from "../../lib/date";
import { computeForm, PIT_PRIORS, PIT_SHRINKAGE_K } from "../../lib/second-third-model";
import { buildPicks, hasRaceStarted, type Picks } from "../lib/picks";
import { legacyGetPitHistories, legacyPredictRace } from "./lib/legacy-predict";
import type { RaceRow } from "../../lib/types";

const tmpDb = path.join(os.tmpdir(), `keirin-verify-${process.pid}.sqlite`);
copyFileSync(LOCAL_DB_PATH, tmpDb);
const sqlite = attachLocalDb(tmpDb);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "NG  "} ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  const allDates = (
    sqlite.prepare("SELECT DISTINCT kaisai_date AS d FROM races ORDER BY d").all() as { d: string }[]
  ).map((r) => r.d);
  const dateSet = new Set(allDates);
  let dates: string[];
  if (process.argv.includes("--all")) {
    dates = allDates;
  } else {
    const picked = new Set<string>();
    for (let i = 0; i < allDates.length; i += 14) {
      picked.add(allDates[i]);
      const next = addDaysToDateStr(allDates[i], 1);
      if (dateSet.has(next)) picked.add(next);
    }
    for (const d of allDates.slice(-2)) picked.add(d);
    dates = [...picked].sort();
  }
  const racesByDate = new Map<string, RaceRow[]>();
  for (const d of dates) racesByDate.set(d, await getRacesByDate(d));
  const totalRaces = [...racesByDate.values()].reduce((a, r) => a + r.length, 0);
  console.log(`対象: ${dates.length}日・${totalRaces}レース（${dates[0]}〜${dates.at(-1)}）\n`);

  // ---- 1. 変更前の経路で全レースの予想（キャッシュ無し） ----
  let t = Date.now();
  const legacy = new Map<number, RacePrediction | null>();
  const legacyJson = new Map<number, string>();
  for (const races of racesByDate.values()) {
    for (const race of races) {
      const p = await legacyPredictRace(race.id);
      legacy.set(race.id, p);
      legacyJson.set(race.id, JSON.stringify(p));
    }
  }
  console.log(`変更前の経路で予想: ${Date.now() - t}ms`);

  t = Date.now();
  let same = 0;
  const diffIds: number[] = [];
  for (const races of racesByDate.values()) {
    const preds = await Promise.all(races.map((r) => predictRace(r.id)));
    races.forEach((r, i) => (JSON.stringify(preds[i]) === legacyJson.get(r.id) ? same++ : diffIds.push(r.id)));
  }
  check(
    "1. predictRace（キャッシュ無し＝ページ表示と同じ経路）が変更前と完全一致",
    diffIds.length === 0,
    `${same}/${totalRaces}件一致${diffIds.length ? ` 不一致例: ${diffIds.slice(0, 5).join(",")}` : ""}（${Date.now() - t}ms）`
  );

  // ---- 2. 2・3着モデル用履歴：全履歴と絞り込み後で computeForm が同一か ----
  let riders = 0;
  let formDiff = 0;
  let legacyRows = 0;
  let newRows = 0;
  for (const [d, races] of racesByDate) {
    const snums = [
      ...new Set(
        (
          sqlite
            .prepare(`SELECT e.snum FROM entries e JOIN races ra ON ra.id = e.race_id WHERE ra.kaisai_date = ?`)
            .all(d) as { snum: string }[]
        ).map((r) => r.snum)
      ),
    ];
    if (races.length === 0 || snums.length === 0) continue;
    const [full, bounded] = await Promise.all([legacyGetPitHistories(snums, d), getPitHistories(snums, d)]);
    for (const s of snums) {
      riders++;
      legacyRows += full.get(s)?.length ?? 0;
      newRows += bounded.get(s)?.length ?? 0;
      const a = JSON.stringify(computeForm(full.get(s) ?? [], d, PIT_PRIORS, PIT_SHRINKAGE_K));
      const b = JSON.stringify(computeForm(bounded.get(s) ?? [], d, PIT_PRIORS, PIT_SHRINKAGE_K));
      if (a !== b) formDiff++;
    }
  }
  check(
    "2. 2・3着モデル用履歴の絞り込みでcomputeFormが不変",
    formDiff === 0,
    `${riders - formDiff}/${riders}選手一致・返却行数 ${legacyRows}→${newRows}（${((newRows / legacyRows) * 100).toFixed(0)}%）`
  );

  // ---- 3. compute-picks相当（読取キャッシュ有効・先読み・前日からの差分合成） ----
  enableReadCache();
  const legacyPicksByDate = new Map<string, Picks>();
  for (const [d, races] of racesByDate) {
    legacyPicksByDate.set(d, buildPicks(races, races.map((r) => legacy.get(r.id) ?? null)));
  }
  const pairs = dates.filter((d) => dateSet.has(d) && racesByDate.has(addDaysToDateStr(d, 1)));
  let predChecked = 0;
  let predDiff = 0;
  let pickRowsChecked = 0;
  let pickDiff = 0;
  let setDiff = 0;
  for (const today of pairs) {
    const tomorrow = addDaysToDateStr(today, 1);
    for (const now of ["05:00", "12:00", "19:00"]) {
      clearReadCache(); // 1回の compute-picks 実行（別プロセス）を再現する
      for (const [d, nowHHMM] of [
        [today, now],
        [tomorrow, null],
      ] as const) {
        const all = racesByDate.get(d) ?? [];
        const races = nowHHMM ? all.filter((r) => !hasRaceStarted(r, nowHHMM)) : all;
        await prefetchRaceInputs(races);
        const preds = await Promise.all(races.map((r) => predictRace(r.id)));
        races.forEach((r, i) => {
          predChecked++;
          if (JSON.stringify(preds[i]) !== legacyJson.get(r.id)) predDiff++;
        });
        const got = buildPicks(races, preds);
        const want = legacyPicksByDate.get(d)!;
        const computed = new Set(races.map((r) => r.id));
        for (const key of ["dailyPicks", "barikataPicks", "barikataNearMisses", "nakaanaPicks"] as const) {
          const wantRows = (want[key] as { raceId: number }[]).filter((p) => computed.has(p.raceId));
          const gotRows = got[key] as { raceId: number }[];
          if (JSON.stringify(wantRows.map((p) => p.raceId)) !== JSON.stringify(gotRows.map((p) => p.raceId))) setDiff++;
          const wantById = new Map(wantRows.map((p) => [p.raceId, JSON.stringify(p)]));
          for (const p of gotRows) {
            pickRowsChecked++;
            if (wantById.get(p.raceId) !== JSON.stringify(p)) pickDiff++;
          }
        }
      }
    }
  }
  check(
    "3a. compute-picks相当の予想（先読み＋差分合成）が変更前と完全一致",
    predDiff === 0,
    `${predChecked - predDiff}/${predChecked}件（${pairs.length}組の当日→翌日×3時刻）`
  );
  check(
    "3b. 厳選/バリカタ/候補漏れ/中穴の各行（買い目・margin含む）が変更前と完全一致",
    pickDiff === 0 && setDiff === 0,
    `${pickRowsChecked - pickDiff}/${pickRowsChecked}行一致・対象レース集合の不一致 ${setDiff}件`
  );

  // ---- 4. daily-summary相当（予想未保存の結果確定レースだけ保存・保存済みは触らない） ----
  const db = getDb();
  await db.execute("DELETE FROM predictions");
  const withResults = (
    sqlite
      .prepare(
        `SELECT DISTINCT ra.kaisai_date AS d FROM races ra JOIN results r ON r.race_id = ra.id
         WHERE r.finish_pos IS NOT NULL ORDER BY d DESC LIMIT 8`
      )
      .all() as { d: string }[]
  )
    .map((r) => r.d)
    .reverse();
  const runSummary = async (days: string[]) => {
    clearReadCache();
    let saved = 0;
    for (const d of days) {
      const candidates = await getRacesWithoutPrediction(d);
      const results = await getResultsForRaces(candidates.map((r) => r.id));
      const finished = candidates.filter(
        (race) => (results.get(race.id) ?? []).filter((r) => r.finish_pos != null && r.finish_pos <= 3).length >= 3
      );
      await prefetchRaceInputs(finished);
      const preds = await Promise.all(finished.map((r) => predictRace(r.id)));
      const items = finished.flatMap((race, i) => {
        const p = preds[i];
        if (!p || p.scored.length === 0) return [];
        return [{ raceId: race.id, scored: p.scored, honmeiFormation: p.scenarios.find((s) => s.label === "本命")?.formation.combinations }];
      });
      await savePredictions(items);
      saved += items.length;
    }
    return saved;
  };
  const firstWindow = withResults.slice(0, 7);
  const saved1 = await runSummary(firstWindow);
  // 期待値：変更前の経路で、結果確定レースの予想をsavePredictionと同じ形に並べたもの
  let expectedRows = 0;
  let rowDiff = 0;
  for (const d of firstWindow) {
    const races = await getRacesByDate(d);
    const results = await getResultsForRaces(races.map((r) => r.id));
    for (const race of races) {
      if ((results.get(race.id) ?? []).filter((r) => r.finish_pos != null && r.finish_pos <= 3).length < 3) continue;
      const p = legacyJson.has(race.id) ? legacy.get(race.id) : await legacyPredictRace(race.id);
      if (!p || p.scored.length === 0) continue;
      const formation = p.scenarios.find((s) => s.label === "本命")?.formation.combinations;
      const want = p.scored.map((s, i) =>
        JSON.stringify([
          s.entry.car_num,
          s.entry.snum,
          s.mark,
          s.totalScore,
          s.lineScore.score,
          s.kyakushitsuScore.score,
          s.statsScore.score,
          i === 0 && formation ? JSON.stringify(formation) : null,
        ])
      );
      const got = (
        sqlite
          .prepare(
            `SELECT car_num, snum, mark, total_score, line_score, kyakushitsu_score, stats_score, formation
             FROM predictions WHERE race_id = ? ORDER BY total_score DESC, car_num`
          )
          .all(race.id) as Record<string, unknown>[]
      ).map((r) => JSON.stringify(Object.values(r)));
      const wantSorted = [...want].sort((a, b) => {
        const [, , , sa] = JSON.parse(a);
        const [, , , sb] = JSON.parse(b);
        return sb - sa || JSON.parse(a)[0] - JSON.parse(b)[0];
      });
      expectedRows += want.length;
      if (JSON.stringify(wantSorted) !== JSON.stringify(got)) rowDiff++;
    }
  }
  const savedRows = (sqlite.prepare("SELECT COUNT(*) AS c FROM predictions").get() as { c: number }).c;
  check(
    "4a. daily-summary相当で保存したpredictionsが変更前の予想と完全一致",
    rowDiff === 0 && savedRows === expectedRows,
    `${saved1}レース保存・${savedRows}/${expectedRows}行・不一致レース ${rowDiff}件（${firstWindow[0]}〜${firstWindow.at(-1)}）`
  );
  const before = JSON.stringify(sqlite.prepare("SELECT * FROM predictions ORDER BY id").all());
  const saved2 = await runSummary(withResults.slice(1, 8));
  const afterOld = JSON.stringify(
    sqlite
      .prepare(`SELECT p.* FROM predictions p JOIN races ra ON ra.id = p.race_id WHERE ra.kaisai_date <= ? ORDER BY p.id`)
      .all(firstWindow.at(-1)!)
  );
  const newDay = withResults[7];
  const newDayRaces = newDay
    ? (sqlite
        .prepare(
          `SELECT COUNT(DISTINCT p.race_id) AS c FROM predictions p JOIN races ra ON ra.id = p.race_id WHERE ra.kaisai_date = ?`
        )
        .get(newDay) as { c: number }).c
    : 0;
  check(
    "4b. 翌日の再実行は保存済みの予想に触れず、新しい日の分だけ保存する",
    before === afterOld && saved2 === newDayRaces,
    `再実行で保存 ${saved2}レース（すべて${newDay ?? "-"}分）・既存行の変化なし=${before === afterOld}`
  );

  console.log(failures === 0 ? "\n全項目一致" : `\n${failures}項目で不一致`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    sqlite.close();
    rmSync(tmpDb, { force: true });
    process.exit(failures === 0 ? 0 : 1);
  });
