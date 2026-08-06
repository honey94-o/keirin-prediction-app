"use client";

import { useActionState } from "react";
import { triggerDailySyncAction, type TriggerSyncResult } from "../lib/actions";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- useActionStateの必須引数
async function runTrigger(prev: TriggerSyncResult | null): Promise<TriggerSyncResult> {
  return triggerDailySyncAction();
}

/**
 * 「今すぐ更新」ボタン。日次自動取得（daily-sync.yml、1日2回）を待たずに、
 * 手動で今すぐ全開催場のデータ取得を開始したい時に使う
 * （例: レースがまだ表示されていない、発走直前でオッズを最新化したい等）。
 */
export function RefreshTrigger({ compact = false }: { compact?: boolean }) {
  const [state, formAction, pending] = useActionState<TriggerSyncResult | null>(
    runTrigger,
    null
  );

  if (compact) {
    return (
      <form action={formAction} className="inline-block">
        <button
          type="submit"
          disabled={pending}
          className="text-xs text-[#0d5c3f] underline disabled:opacity-50"
        >
          {pending ? "更新中…" : "今すぐ更新"}
        </button>
        {state && (
          <p className={`text-xs mt-1 ${state.ok ? "text-green-700" : "text-red-600"}`}>
            {state.message}
          </p>
        )}
      </form>
    );
  }

  return (
    <form action={formAction} className="text-center">
      <button
        type="submit"
        disabled={pending}
        className="bg-[#0d5c3f] text-white rounded-lg px-4 py-2 font-semibold disabled:opacity-50 active:opacity-80"
      >
        {pending ? "更新を開始しています…" : "今すぐ更新する"}
      </button>
      {state && (
        <p className={`text-xs mt-2 ${state.ok ? "text-green-700" : "text-red-600"}`}>
          {state.message}
        </p>
      )}
      <p className="text-xs text-gray-400 mt-2">
        全開催場のデータ取得を開始します（完了まで1〜2分ほどかかります）
      </p>
    </form>
  );
}
