"use client";

import { useActionState } from "react";
import {
  triggerScrapeAction,
  triggerVenueSyncAction,
  type TriggerScrapeResult,
} from "../lib/actions";
import { KEIRIN_VENUES } from "../lib/venues";

async function runTrigger(
  _prev: TriggerScrapeResult | null,
  formData: FormData
): Promise<TriggerScrapeResult> {
  const venueName = String(formData.get("venueName") ?? "");
  const raceNo = Number(formData.get("raceNo"));
  return triggerScrapeAction(venueName, raceNo);
}

async function runVenueSync(): Promise<TriggerScrapeResult> {
  return triggerVenueSyncAction();
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export function ScrapeTriggerForm({
  todayVenues,
  syncedDate,
}: {
  todayVenues: string[];
  syncedDate: string | null;
}) {
  const [state, formAction, pending] = useActionState(runTrigger, null);
  const [syncState, syncAction, syncPending] = useActionState(runVenueSync, null);

  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const isFresh = syncedDate === todayStr;
  const venueOptions = todayVenues.length > 0 ? todayVenues : KEIRIN_VENUES;

  return (
    <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-sm text-gray-600">新しいレースを取得</h2>
        <button
          type="button"
          onClick={() => syncAction()}
          disabled={syncPending}
          className="text-xs text-[#0d5c3f] underline disabled:opacity-50"
        >
          {syncPending ? "更新中…" : "開催場を更新"}
        </button>
      </div>

      <p className="text-xs text-gray-400 mb-2">
        {todayVenues.length > 0 ? (
          <>
            {isFresh ? "本日" : `${syncedDate ? formatDate(syncedDate) : "?"}時点`}
            の開催場一覧（{todayVenues.length}件）
            {!isFresh && " ※本日分に更新してください"}
          </>
        ) : (
          "本日の開催場一覧が未取得のため、全競輪場を表示しています（実際に開催中か分かりません）"
        )}
      </p>
      {syncState && (
        <p className={`text-xs mb-2 ${syncState.ok ? "text-green-700" : "text-red-600"}`}>
          {syncState.message}
        </p>
      )}

      <form action={formAction}>
        <div className="flex gap-2 mb-2">
          <select
            name="venueName"
            required
            className="flex-1 border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white"
          >
            <option value="">開催場を選択</option>
            {venueOptions.map((v) => (
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
      </form>
      {state && (
        <p className={`text-xs mt-2 ${state.ok ? "text-green-700" : "text-red-600"}`}>
          {state.message}
        </p>
      )}
      <p className="text-xs text-gray-400 mt-2">
        本日その開催場でレースが発売されていない場合は取得に失敗します。取得完了まで1〜2分ほどかかります。
      </p>
    </section>
  );
}
