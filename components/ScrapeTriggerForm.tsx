"use client";

import { useActionState } from "react";
import { triggerScrapeAction, type TriggerScrapeResult } from "../lib/actions";
import { KEIRIN_VENUES } from "../lib/venues";

async function runTrigger(
  _prev: TriggerScrapeResult | null,
  formData: FormData
): Promise<TriggerScrapeResult> {
  const venueName = String(formData.get("venueName") ?? "");
  const raceNo = Number(formData.get("raceNo"));
  return triggerScrapeAction(venueName, raceNo);
}

export function ScrapeTriggerForm() {
  const [state, formAction, pending] = useActionState(runTrigger, null);

  return (
    <form action={formAction} className="bg-white rounded-lg shadow-sm p-4 mb-4">
      <h2 className="font-semibold text-sm text-gray-600 mb-2">新しいレースを取得</h2>
      <div className="flex gap-2 mb-2">
        <select
          name="venueName"
          required
          className="flex-1 border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white"
        >
          <option value="">開催場を選択</option>
          {KEIRIN_VENUES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          name="raceNo"
          required
          defaultValue="1"
          className="w-20 border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}R
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full bg-[#0d5c3f] text-white rounded-lg py-2 font-semibold disabled:opacity-50 active:opacity-80"
      >
        {pending ? "開始しています…" : "取得する"}
      </button>
      {state && (
        <p className={`text-xs mt-2 ${state.ok ? "text-green-700" : "text-red-600"}`}>
          {state.message}
        </p>
      )}
      <p className="text-xs text-gray-400 mt-2">
        本日その開催場でレースが発売されていない場合は取得に失敗します（開催状況はGitHub Actionsのログで確認できます）。取得完了まで1〜2分ほどかかります。
      </p>
    </form>
  );
}
