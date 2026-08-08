import Link from "next/link";
import {
  getDailyPicks,
  getDailyPicksResults,
  getDailyPicksPerformance,
} from "../../lib/repository";
import { predictRace } from "../../lib/predict";
import { formatFormationNotation } from "../../lib/scoring";
import { todayJstStr, addDaysToDateStr, formatDateStr, isValidDateStr } from "../../lib/date";
import { PicksTabs } from "../../components/PicksTabs";

export const dynamic = "force-dynamic";

const PERFORMANCE_WINDOW_DAYS = 30;

export default async function PicksPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const todayStr = todayJstStr();
  const viewDate = isValidDateStr(date) ? date : todayStr;
  const prevDate = addDaysToDateStr(viewDate, -1);

  const last30Dates = Array.from({ length: PERFORMANCE_WINDOW_DAYS }, (_, i) =>
    addDaysToDateStr(viewDate, -1 - i)
  );

  const [picks, prevResults, performance30d] = await Promise.all([
    getDailyPicks(viewDate),
    getDailyPicksResults(prevDate),
    getDailyPicksPerformance(last30Dates),
  ]);

  // 発走時刻順に並べ替える（本命の信頼度順ではなく、当日の時系列でタブを追える方が
  // 実際に馬券を買う時に使いやすいため）。
  const sortedPicks = [...picks].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  const predictions = await Promise.all(sortedPicks.map((p) => predictRace(p.race_id)));
  const items = sortedPicks
    .map((p, i) => ({ pick: p, prediction: predictions[i] }))
    .filter(
      (item): item is { pick: (typeof sortedPicks)[number]; prediction: NonNullable<(typeof predictions)[number]> } =>
        item.prediction != null
    );

  const prevFinished = prevResults.filter((r) => r.finished);
  const prevHits = prevFinished.filter((r) => r.hit).length;
  const prevStake = prevFinished.reduce((sum, r) => sum + (r.stakeYen ?? 0), 0);
  const prevPayout = prevFinished.reduce((sum, r) => sum + (r.payoutYen ?? 0), 0);
  const prevRoi = prevStake > 0 ? (prevPayout / prevStake) * 100 : null;

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href={`/?date=${viewDate}`} className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← ホームに戻る
      </Link>
      <h1 className="text-lg font-bold mb-1">厳選レース（{formatDateStr(viewDate)}）</h1>
      <p className="text-xs text-gray-400 mb-4">
        本命の信頼度が高い上位{items.length}レースを発走時刻順に表示。買い目は「本命」フォーメーション（1レース20点以内）が対象です。
      </p>

      {/* 直近30日の実績回収率 */}
      <section className="bg-white rounded-lg shadow-sm p-3 mb-4">
        <h2 className="text-xs font-semibold text-gray-600 mb-2">
          直近{PERFORMANCE_WINDOW_DAYS}日の実績（
          {formatDateStr(last30Dates[last30Dates.length - 1])} 〜 {formatDateStr(last30Dates[0])}）
        </h2>
        {performance30d.races === 0 ? (
          <p className="text-sm text-gray-400">結果確定済みのデータがまだありません。</p>
        ) : (
          <div className="grid grid-cols-3 gap-y-1 text-sm">
            <div className="text-gray-500">対象レース</div>
            <div className="col-span-2 text-right tabular-nums">{performance30d.races}レース</div>
            <div className="text-gray-500">的中率</div>
            <div className="col-span-2 text-right tabular-nums">
              {((performance30d.hits / performance30d.races) * 100).toFixed(1)}% ({performance30d.hits}/{performance30d.races})
            </div>
            <div className="text-gray-500">回収率</div>
            <div
              className={`col-span-2 text-right font-semibold tabular-nums ${
                (performance30d.roi ?? 0) >= 100 ? "text-green-700" : "text-gray-700"
              }`}
            >
              {performance30d.roi?.toFixed(1)}%
            </div>
          </div>
        )}
      </section>

      {/* 前日の結果：買い目・結果・払い戻し・回収率をレースごとに、トータル回収率を上部に表示 */}
      <section className="bg-white rounded-lg shadow-sm p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-gray-600">前日（{formatDateStr(prevDate)}）の結果</h2>
          {prevFinished.length > 0 && (
            <span className="text-xs font-semibold">
              {prevHits}/{prevFinished.length}的中 ・ トータル回収率
              <span className={(prevRoi ?? 0) >= 100 ? "text-green-700" : "text-gray-700"}>
                {" "}
                {prevRoi?.toFixed(1)}%
              </span>
            </span>
          )}
        </div>
        {prevResults.length === 0 ? (
          <p className="text-sm text-gray-400">前日の厳選レースはありませんでした。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-100">
            {prevResults.map((r) => {
              const notation = r.pick.formation ? formatFormationNotation(r.pick.formation) : null;
              const raceRoi = r.stakeYen && r.stakeYen > 0 ? ((r.payoutYen ?? 0) / r.stakeYen) * 100 : null;
              return (
                <li key={r.pick.race_id} className="py-2">
                  <Link
                    href={`/races/${r.pick.race_id}/bets`}
                    className="flex items-center gap-2 active:bg-gray-50 -mx-1 px-1 rounded"
                  >
                    <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0">
                      {r.pick.start_time ?? "--:--"}
                    </span>
                    <span className="text-sm text-gray-900 w-20 shrink-0 truncate">
                      {r.pick.keirinjo_name}
                      {r.pick.race_no}R
                    </span>
                    <span className="flex-1 font-mono text-xs text-gray-600 truncate">
                      {notation ?? "-"}
                    </span>
                    {!r.finished ? (
                      <span className="text-xs text-gray-400 shrink-0">結果未確定</span>
                    ) : (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                          r.hit ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {r.hit ? "的中" : "不的中"}
                      </span>
                    )}
                  </Link>
                  {r.finished && (
                    <div className="flex items-center justify-end gap-4 mt-1 text-xs text-gray-500 tabular-nums">
                      <span>買い目 {r.stakeYen ?? 0}円</span>
                      <span>払戻 {(r.payoutYen ?? 0).toFixed(0)}円</span>
                      <span className={raceRoi != null && raceRoi >= 100 ? "text-green-700 font-semibold" : ""}>
                        回収率 {raceRoi != null ? `${raceRoi.toFixed(0)}%` : "-"}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8">
          {formatDateStr(viewDate)}の厳選レースはまだありません。
        </p>
      ) : (
        <>
          {/* 本日の買い目一覧（全件） */}
          <section className="bg-white rounded-lg shadow-sm p-3 mb-4">
            <h2 className="text-xs font-semibold text-gray-600 mb-2">
              本日の買い目一覧（{items.length}レース）
            </h2>
            <ul className="flex flex-col divide-y divide-gray-100">
              {items.map(({ pick, prediction }) => {
                const honmeiScenario = prediction.scenarios.find((s) => s.label === "本命");
                const notation = honmeiScenario
                  ? formatFormationNotation(honmeiScenario.formation.combinations)
                  : null;
                return (
                  <li key={pick.race_id} className="py-2 flex items-center gap-2">
                    <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0">
                      {pick.start_time ?? "--:--"}
                    </span>
                    <span className="text-sm text-gray-900 w-24 shrink-0 truncate">
                      {pick.keirinjo_name}
                      {pick.race_no}R
                    </span>
                    <span className="flex-1 font-mono font-bold tabular-nums text-[#0d5c3f] text-sm truncate">
                      {notation ?? "-"}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">
                      {honmeiScenario?.formation.combinations.length ?? 0}点
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <h2 className="text-xs font-semibold text-gray-600 mb-2">レースごとの詳細</h2>
          <PicksTabs items={items} />
        </>
      )}

      <p className="text-xs text-gray-400 mt-6 leading-relaxed">
        選定方法：その日の本命（◎と対抗のスコア差）が大きい順に上位10件を機械的に選出。
        「直近{PERFORMANCE_WINDOW_DAYS}日の実績」は各日実際に表示した買い目のスナップショットで判定しており、
        後からスコアリングを調整しても過去の結果表示は変わりません。ギャンブルのため回収率100%超えを毎回保証するものではありません。
      </p>
    </main>
  );
}
