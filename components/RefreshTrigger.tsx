"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getDailySyncStatusAction,
  triggerDailySyncAction,
  type TriggerSyncResult,
} from "../lib/actions";

const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

type Phase =
  | { kind: "idle" }
  | { kind: "running"; since: number }
  | { kind: "done"; finishedAt: string; ok: boolean };

function jstHHMM(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
}

/**
 * 「今すぐ更新」ボタン。押すとGitHub Actionsのdaily-sync.ymlを起動し、完了まで実行状況を
 * 見に行って進み具合を表示する。完了したら画面を最新のデータで描き直す（同期ジョブの
 * 最後でキャッシュの失効と暖機が済んでいるため、router.refreshで新しい内容が出る）。
 * 定期実行が動いている最中に開いた場合も「更新中」と表示する。
 */
export function RefreshTrigger({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [state, formAction, pending] = useActionState<TriggerSyncResult | null>(async () => {
    const result = await triggerDailySyncAction();
    // 起動できたら（既に実行中だった場合も）完了を待つ
    if (result.ok) setPhase({ kind: "running", since: Date.now() });
    return result;
  }, null);
  const [now, setNow] = useState(() => Date.now());
  // 「どの完了時刻より新しくなったら完了とみなすか」の基準（起動前に見えていた最後の完了時刻）
  const baselineRef = useRef<string | null>(null);

  const poll = useCallback(async () => {
    const status = await getDailySyncStatusAction();
    if (status.running) return false;
    if (status.lastFinishedAt && status.lastFinishedAt !== baselineRef.current) {
      setPhase({ kind: "done", finishedAt: status.lastFinishedAt, ok: status.lastConclusion === "success" });
      router.refresh();
      return true;
    }
    return false;
  }, [router]);

  // 開いた時点で定期実行が動いていれば「更新中」を出す
  useEffect(() => {
    let cancelled = false;
    getDailySyncStatusAction().then((status) => {
      if (cancelled) return;
      baselineRef.current = status.lastFinishedAt;
      if (status.running) setPhase({ kind: "running", since: Date.now() });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== "running") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const timer = setInterval(async () => {
      if (Date.now() - phase.since > POLL_TIMEOUT_MS) {
        setPhase({ kind: "idle" });
        return;
      }
      await poll();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(timer);
    };
  }, [phase, poll]);

  const statusText =
    phase.kind === "running"
      ? `更新中…（${Math.max(0, Math.floor((now - phase.since) / 1000))}秒）`
      : phase.kind === "done"
        ? phase.ok
          ? `更新完了 ${jstHHMM(phase.finishedAt)}`
          : `更新は終了しましたが一部失敗しました（${jstHHMM(phase.finishedAt)}、次回の自動更新で取り直します）`
        : null;
  const statusClass =
    phase.kind === "done" && !phase.ok ? "text-rose-soft" : phase.kind === "done" ? "text-mint" : "text-mist-2";
  // 起動に失敗した時だけ、サーバーからのメッセージ（理由）をそのまま出す
  const errorText = state && !state.ok ? state.message : null;
  const busy = pending || phase.kind === "running";

  if (compact) {
    return (
      <form action={formAction} className="inline-block text-right">
        <button type="submit" disabled={busy} className="text-xs text-mint-strong underline disabled:opacity-50">
          {busy ? "更新中…" : "今すぐ更新"}
        </button>
        {statusText && <p className={`text-[10px] mt-1 ${statusClass}`}>{statusText}</p>}
        {errorText && <p className="text-xs mt-1 text-rose-soft">{errorText}</p>}
      </form>
    );
  }

  return (
    <form action={formAction} className="text-center">
      <button
        type="submit"
        disabled={busy}
        className="bg-mint text-mint-ink rounded-lg px-4 py-2 font-semibold disabled:opacity-50 active:opacity-80"
      >
        {pending ? "更新を開始しています…" : phase.kind === "running" ? "更新中…" : "今すぐ更新する"}
      </button>
      {statusText && <p className={`text-xs mt-2 ${statusClass}`}>{statusText}</p>}
      {errorText && <p className="text-xs mt-2 text-rose-soft">{errorText}</p>}
      <p className="text-xs text-mist-3 mt-2">
        全開催場のデータ取得を開始します（完了まで約2分。完了すると自動で最新の表示に切り替わります）
      </p>
    </form>
  );
}
