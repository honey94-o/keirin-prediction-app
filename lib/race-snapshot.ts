/**
 * レース単位の予想スナップショット（race_snapshotsテーブル、db/schema.sql参照）。
 *
 * ホーム（厳選等の「実際は○○が的中」）・/picks（上位4車と本命の買い目）・開催場ページ
 * （「高信頼度」バッジ）は、以前は表示のたびにpredictRace（1レースあたりDB十数回、
 * 選手の全履歴を読むため転送量も大きい）を何レース分も実行していた。
 * scripts/compute-picks.tsが厳選等と同じ実行で全レース分をここに保存し、画面はこれを読む。
 *
 * 保存側（scripts）と、行が無い時にpredictRaceの結果から同じ形を作る表示側
 * （lib/queries/home.ts）の両方でsnapshotFromPredictionを共有し、どちらの経路でも
 * 画面に出る値が同じになるようにする。Next.jsに依存しない（scriptsからも読む）こと。
 */
import { getDb, type DbStatement } from "./db";
import type { RacePrediction } from "./predict";
import type { ScoreWeights } from "./types";

/** /picksで表示する上位の車数（PicksTabsの「上位4車」）。 */
export const SNAPSHOT_TOP_N = 4;

export interface SnapshotEntry {
  carNum: number;
  name: string;
  mark: string;
}

export interface SnapshotScenario {
  label: string;
  combinations: string[];
}

export interface RaceSnapshot {
  raceId: number;
  /** ◎と対抗の総合スコア差（出走2車未満はnull）。 */
  margin: number | null;
  top: SnapshotEntry[];
  /** generateScenariosの順（ホームの「実際は○○が的中」は先頭から最初に一致したものを出すため順序が意味を持つ）。 */
  scenarios: SnapshotScenario[];
  /** 本命シナリオの説明文（/picks用）。本命シナリオが無ければnull。 */
  honmeiReason: string | null;
  /** 計算に使ったスコア重み。設定画面で変えた後は表示側が計算し直す判定に使う。 */
  weights: ScoreWeights;
}

export function snapshotFromPrediction(
  raceId: number,
  prediction: RacePrediction,
  weights: ScoreWeights
): RaceSnapshot {
  const { scored, scenarios } = prediction;
  return {
    raceId,
    margin: scored.length >= 2 ? scored[0].totalScore - scored[1].totalScore : null,
    top: scored.slice(0, SNAPSHOT_TOP_N).map((s) => ({ carNum: s.entry.car_num, name: s.entry.name, mark: s.mark })),
    scenarios: scenarios.map((s) => ({ label: s.label, combinations: s.formation.combinations })),
    honmeiReason: scenarios.find((s) => s.label === "本命")?.reason ?? null,
    weights,
  };
}

export function sameWeights(a: ScoreWeights, b: ScoreWeights): boolean {
  return a.line === b.line && a.kyakushitsu === b.kyakushitsu && a.stats === b.stats;
}

/** race_snapshotsの1行（JSON列は文字列のまま）。 */
export interface RaceSnapshotDbRow {
  race_id: number;
  margin: number | null;
  top_entries: string;
  scenarios: string;
  honmei_reason: string | null;
  weights: string;
}

export function parseRaceSnapshotRow(row: RaceSnapshotDbRow): RaceSnapshot {
  return {
    raceId: row.race_id,
    margin: row.margin,
    top: JSON.parse(row.top_entries) as SnapshotEntry[],
    scenarios: JSON.parse(row.scenarios) as SnapshotScenario[],
    honmeiReason: row.honmei_reason,
    weights: JSON.parse(row.weights) as ScoreWeights,
  };
}

/**
 * スナップショットを保存する（scripts/compute-picks.tsから呼ぶ。race_id単位のUPSERTなので、
 * 計算し直さなかった発走済みレースの行は前回の値のまま残る＝厳選等のテーブルと同じ扱い）。
 */
export async function saveRaceSnapshots(kaisaiDate: string, snapshots: RaceSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;
  const statements: DbStatement[] = [];
  for (let i = 0; i < snapshots.length; i += 200) {
    const chunk = snapshots.slice(i, i + 200);
    statements.push({
      sql: `INSERT INTO race_snapshots (race_id, kaisai_date, margin, top_entries, scenarios, honmei_reason,
                                        weights, updated_at) VALUES
            ${chunk.map(() => "(?,?,?,?,?,?,?,datetime('now'))").join(",")}
            ON CONFLICT(race_id) DO UPDATE SET
              kaisai_date=excluded.kaisai_date, margin=excluded.margin, top_entries=excluded.top_entries,
              scenarios=excluded.scenarios, honmei_reason=excluded.honmei_reason, weights=excluded.weights,
              updated_at=datetime('now')`,
      args: chunk.flatMap((s) => [
        s.raceId,
        kaisaiDate,
        s.margin,
        JSON.stringify(s.top),
        JSON.stringify(s.scenarios),
        s.honmeiReason,
        JSON.stringify(s.weights),
      ]),
    });
  }
  await getDb().batch(statements);
}
