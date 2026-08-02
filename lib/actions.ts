"use server";

import { revalidatePath } from "next/cache";
import { predictRace } from "./predict";
import { savePrediction, setScoreWeights } from "./repository";
import type { ScoreWeights } from "./types";

const GITHUB_REPO_OWNER = "honey94-o";
const GITHUB_REPO_NAME = "keirin-prediction-app";

export interface TriggerScrapeResult {
  ok: boolean;
  message: string;
}

/**
 * Vercelのサーバーレス関数はPlaywright（ブラウザ自動化）を直接実行できないため、
 * GitHub ActionsのワークフローをGitHub APIでトリガーする方式にしている。
 * 実行は非同期（GitHub Actions側で数十秒〜数分かかる）ため、この関数は
 * 「開始できたか」までしか分からない。完了後は該当画面を再読み込みして確認する。
 */
async function dispatchWorkflow(
  workflowFile: string,
  inputs: Record<string, string>
): Promise<{ status: number; body: string }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { status: 0, body: "GITHUB_TOKENが未設定です（サーバー設定を確認してください）" };
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "master", inputs }),
    }
  );

  return { status: res.status, body: res.status === 204 ? "" : await res.text() };
}

export async function triggerScrapeAction(
  venueName: string,
  raceNo: number
): Promise<TriggerScrapeResult> {
  const { status, body } = await dispatchWorkflow("scrape.yml", {
    venue_name: venueName,
    race_no: String(raceNo),
  });

  if (status === 204) {
    return {
      ok: true,
      message: `${venueName} ${raceNo}Rの取得を開始しました。1〜2分後にレース一覧に反映されます。`,
    };
  }
  return { ok: false, message: `取得開始に失敗しました (${status}): ${body.slice(0, 200)}` };
}

/** 本日の開催場一覧キャッシュを更新するワークフローをトリガーする。 */
export async function triggerVenueSyncAction(): Promise<TriggerScrapeResult> {
  const { status, body } = await dispatchWorkflow("sync-venues.yml", {});

  if (status === 204) {
    return {
      ok: true,
      message: "本日の開催場一覧を更新中です。30秒〜1分後にこのページを開き直してください。",
    };
  }
  return { ok: false, message: `更新開始に失敗しました (${status}): ${body.slice(0, 200)}` };
}

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
