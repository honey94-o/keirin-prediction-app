"use server";

import { revalidatePath } from "next/cache";
import { predictRace } from "./predict";
import { savePrediction, setScoreWeights } from "./repository";
import type { ScoreWeights } from "./types";

/** 現在のスコアを発走前の予想としてスナップショット保存する。 */
export async function recordPredictionAction(raceId: number): Promise<void> {
  const prediction = await predictRace(raceId);
  if (!prediction) return;
  await savePrediction(raceId, prediction.scored);
  revalidatePath(`/races/${raceId}`);
  revalidatePath("/history");
}

/**
 * 設定画面からの重み保存。3つの値の合計が1になるよう正規化してから保存する
 * （スライダーの生値をそのまま保存すると合計スコアのスケールが崩れるため）。
 */
export async function updateWeightsAction(formData: FormData): Promise<void> {
  const line = Number(formData.get("line"));
  const kyakushitsu = Number(formData.get("kyakushitsu"));
  const stats = Number(formData.get("stats"));

  const sum = line + kyakushitsu + stats;
  const weights: ScoreWeights =
    sum > 0
      ? { line: line / sum, kyakushitsu: kyakushitsu / sum, stats: stats / sum }
      : { line: 1 / 3, kyakushitsu: 1 / 3, stats: 1 / 3 };

  await setScoreWeights(weights);
  revalidatePath("/settings");
  revalidatePath("/", "layout");
}
