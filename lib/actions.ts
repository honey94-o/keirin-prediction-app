"use server";

import { revalidatePath } from "next/cache";
import { predictRace } from "./predict";
import { savePrediction, setScoreWeights, addFavoriteRacer, removeFavoriteRacer } from "./repository";
import type { ScoreWeights } from "./types";

const GITHUB_REPO_OWNER = "honey94-o";
const GITHUB_REPO_NAME = "keirin-prediction-app";

export interface TriggerSyncResult {
  ok: boolean;
  message: string;
}

/**
 * レースがまだ表示されていない時に「今すぐ更新」で使う手動トリガー。
 * daily-sync.yml（全43開催場の自動取得ワークフロー）をGitHub APIで
 * 即時実行する。Vercelのサーバーレス関数はPlaywright等を直接実行できず、
 * WINTICKETへのスクレイピング自体はGitHub Actions側で行う必要があるため
 * （詳細はREADME「データ取得」参照）。実行は非同期（数分かかる）なので、
 * この関数は「開始できたか」までしか分からない。
 */
export async function triggerDailySyncAction(): Promise<TriggerSyncResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, message: "GITHUB_TOKENが未設定です（サーバー設定を確認してください）" };
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/daily-sync.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "master", inputs: {} }),
    }
  );

  if (res.status === 204) {
    // 「開始できたか」の返事であり、取得完了の合図ではない（GitHub Actionsの
    // dispatchは受理された時点で204を返すため一瞬で戻る）。全43開催場の実際の
    // 取得はここから数分〜十数分かかる（daily-sync.ymlのworkflow_dispatch実行
    // 履歴で実測できる。以前「1〜2分」と表示していたが、実測30〜40分に対して
    // 大幅に楽観的すぎたため訂正した）。
    return {
      ok: true,
      message: "更新を開始しました。全開催場の取得には数分〜十数分かかります。少し時間を置いてから開き直してください。",
    };
  }
  const body = await res.text();
  return { ok: false, message: `更新開始に失敗しました (${res.status}): ${body.slice(0, 200)}` };
}

/** 現在のスコアを発走前の予想としてスナップショット保存する。 */
export async function recordPredictionAction(raceId: number): Promise<void> {
  const prediction = await predictRace(raceId);
  if (!prediction) return;
  const honmeiFormation = prediction.scenarios.find((s) => s.label === "本命")?.formation.combinations;
  await savePrediction(raceId, prediction.scored, honmeiFormation);
  revalidatePath(`/races/${raceId}`);
  revalidatePath("/history");
}

/** 選手ページのお気に入り登録/解除トグル。 */
export async function toggleFavoriteRacerAction(
  snum: string,
  currentlyFavorite: boolean
): Promise<void> {
  if (currentlyFavorite) {
    await removeFavoriteRacer(snum);
  } else {
    await addFavoriteRacer(snum);
  }
  revalidatePath(`/racers/${snum}`);
  revalidatePath("/");
  revalidatePath("/settings");
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
