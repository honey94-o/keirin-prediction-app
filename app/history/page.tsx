import Link from "next/link";
import {
  getRaceIdsWithPrediction,
  getDailyPicksResults,
  getBarikataPicksResults,
  getCombinedPickHitHistory,
} from "../../lib/repository";
import {
  getBulkRaceSummaries,
  getOverallAccuracyStats,
  getGirlsAccuracyStats,
  getDailySummary,
  getGirlsDailySummary,
  yesterdayJst,
} from "../../lib/accuracy";
import { addDaysToDateStr, formatDateStr, isValidDateStr, todayJstStr } from "../../lib/date";
import { formatFormationNotation } from "../../lib/scoring";

const COMBINED_HISTORY_DAYS = 14;

// レース結果はGitHub Actions（Next.jsの外）からTursoへ書き込まれるため、
// 静的生成だと反映されない。常に最新を読むよう動的レンダリングを強制する。
export const dynamic = "force-dynamic";

function formatDate(kaisaiDate: string): string {
  const y = kaisaiDate.slice(0, 4);
  const m = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  return `${y}/${m}/${d}`;
}

function fmtPct(v: number | null): string {
  return v == null ? "-" : `${v.toFixed(0)}%`;
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const latestDate = yesterdayJst(); // 当日はまだ結果が揃っていないため、閲覧可能な最新日は前日まで
  const viewDate = isValidDateStr(date) && date <= latestDate ? date : latestDate;
  const prevDate = addDaysToDateStr(viewDate, -1);
  const nextDate = addDaysToDateStr(viewDate, 1);

  // 「今日の的中」（ホーム画面）を複数日ぶん振り返れるように、当日を含む直近N日の
  // 厳選+バリカタ合算的中実績を日別に並べる。
  const historyDates = Array.from({ length: COMBINED_HISTORY_DAYS }, (_, i) =>
    addDaysToDateStr(todayJstStr(), -i)
  );
  const combinedHistory = await getCombinedPickHitHistory(historyDates);

  const raceIds = await getRaceIdsWithPrediction();
  const summaries = await getBulkRaceSummaries(raceIds);
  const stats = await getOverallAccuracyStats();
  const girlsStats = await getGirlsAccuracyStats();
  const daily = await getDailySummary(viewDate);
  const girlsDaily = await getGirlsDailySummary(viewDate);
  const [pickResults, barikataResults] = await Promise.all([
    getDailyPicksResults(viewDate),
    getBarikataPicksResults(viewDate),
  ]);
  const pickFinished = pickResults.filter((r) => r.finished);
  const pickHits = pickFinished.filter((r) => r.hit).length;
  const pickStake = pickFinished.reduce((sum, r) => sum + (r.stakeYen ?? 0), 0);
  const pickPayout = pickFinished.reduce((sum, r) => sum + (r.payoutYen ?? 0), 0);
  const pickRoi = pickStake > 0 ? (pickPayout / pickStake) * 100 : null;
  const barikataFinished = barikataResults.filter((r) => r.finished);
  const barikataHits = barikataFinished.filter((r) => r.hit).length;
  const barikataStake = barikataFinished.reduce((sum, r) => sum + (r.stakeYen ?? 0), 0);
  const barikataPayout = barikataFinished.reduce((sum, r) => sum + (r.payoutYen ?? 0), 0);
  const barikataRoi = barikataStake > 0 ? (barikataPayout / barikataStake) * 100 : null;

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-4 dark:text-gray-100">予想履歴・精度検証</h1>

      {combinedHistory.some((d) => d.total > 0) && (
        <section className="bg-white rounded-lg shadow-sm p-4 mb-4 dark:bg-gray-800">
          <h2 className="font-semibold text-sm text-gray-600 mb-2 dark:text-gray-300">
            今日の的中（厳選+バリカタ合算）・直近{COMBINED_HISTORY_DAYS}日
          </h2>
          <ul className="flex flex-col divide-y divide-gray-100 dark:divide-gray-700">
            {combinedHistory
              .filter((d) => d.total > 0)
              .map((d) => (
                <li key={d.date}>
                  <Link
                    // 「本日」はgetDailySummary側が結果確定済み扱いしないため専用の
                    // 日別詳細を持たない。ホーム画面（今まさに進行中のビュー）に戻す。
                    href={d.date === todayJstStr() ? "/" : `/history?date=${d.date}`}
                    className="flex items-center justify-between text-sm py-1.5 active:bg-gray-50 -mx-1 px-1 rounded dark:active:bg-gray-700"
                  >
                    <span className="text-gray-700 dark:text-gray-300">
                      {formatDateStr(d.date)}
                      {d.date === todayJstStr() && (
                        <span className="text-xs text-gray-400 ml-1 dark:text-gray-500">(本日・進行中)</span>
                      )}
                    </span>
                    <span className="font-semibold tabular-nums dark:text-gray-100">
                      {d.hits}/{d.total}
                      <span className="text-xs text-gray-400 ml-1 dark:text-gray-500">
                        ({((d.hits / d.total) * 100).toFixed(0)}%)
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4 dark:bg-gray-800">
        <div className="flex items-center justify-between mb-2">
          <Link
            href={`/history?date=${prevDate}`}
            className="text-sm text-[#0d5c3f] px-2 py-1 -ml-2 dark:text-emerald-400"
          >
            ← 前日
          </Link>
          <h2 className="font-semibold text-sm text-gray-600 dark:text-gray-300">
            {formatDateStr(viewDate)}のサマリー
            <span className="text-gray-400 font-normal dark:text-gray-500">（ガールズ除く）</span>
          </h2>
          {nextDate <= latestDate ? (
            <Link
              href={`/history?date=${nextDate}`}
              className="text-sm text-[#0d5c3f] px-2 py-1 -mr-2 dark:text-emerald-400"
            >
              翌日 →
            </Link>
          ) : (
            <span className="text-sm text-gray-300 px-2 py-1 -mr-2 dark:text-gray-600">翌日 →</span>
          )}
        </div>

        {daily.totalRaces === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4 dark:text-gray-500">
            この日はまだレース結果・予想がありません。
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-y-2 text-sm mb-3 dark:text-gray-200">
              <div>結果確定レース</div>
              <div className="text-right tabular-nums">{daily.totalRaces}レース</div>
              <div>◎ 単勝的中率</div>
              <div className="text-right tabular-nums">{fmtPct(daily.honmeiHitRate)}</div>
              <div>3連単フォーメーション的中率</div>
              <div className="text-right tabular-nums">{fmtPct(daily.sanrentanHitRate)}</div>
              <div>回収率（参考値）</div>
              <div className="text-right tabular-nums">{fmtPct(daily.overallRoi)}</div>
            </div>
            {daily.topPayouts.length > 0 && (
              <>
                <h3 className="text-xs font-semibold text-gray-500 mb-1 dark:text-gray-400">
                  配当ベスト{daily.topPayouts.length}（的中レース）
                </h3>
                <ul className="flex flex-col gap-1">
                  {daily.topPayouts.map((p, i) => (
                    <li key={p.race.id}>
                      <Link
                        href={`/races/${p.race.id}`}
                        className="flex items-center justify-between text-sm px-2 py-1.5 rounded bg-amber-50 active:bg-amber-100 dark:bg-amber-950 dark:active:bg-amber-900"
                      >
                        <span className="text-gray-700 dark:text-gray-300">
                          {i + 1}位 {p.race.keirinjo_name}{p.race.race_no}R（{p.combo}）
                        </span>
                        <span className="font-semibold text-amber-800 tabular-nums dark:text-amber-400">
                          {p.payoutYen.toFixed(0)}円
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {girlsDaily.totalRaces > 0 && (
        <section className="bg-purple-50 border border-purple-200 rounded-lg shadow-sm p-4 mb-4 dark:bg-purple-950 dark:border-purple-900">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold bg-purple-600 text-white px-2 py-0.5 rounded-full">
              ガールズケイリン
            </span>
            <span className="text-xs text-purple-800 dark:text-purple-400">
              ラインが無く決まり方が違うため集計を分けています
            </span>
          </div>
          <div className="grid grid-cols-2 gap-y-1 text-sm mb-2 pb-2 border-b border-purple-200 dark:border-purple-900">
            <div className="text-purple-700 dark:text-purple-400">{formatDateStr(viewDate)}</div>
            <div className="text-right tabular-nums dark:text-gray-200">
              {girlsDaily.totalRaces}レース ・ ◎{fmtPct(girlsDaily.honmeiHitRate)} ・ 回収率
              {fmtPct(girlsDaily.overallRoi)}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-y-1 text-sm">
            <div className="text-purple-700 dark:text-purple-400">直近（{girlsStats.totalRaces}レース）</div>
            <div className="text-right tabular-nums dark:text-gray-200">
              ◎{fmtPct(girlsStats.honmeiHitRate)} ・ 3連単{fmtPct(girlsStats.sanrentanHitRate)} ・ 回収率
              {fmtPct(girlsStats.overallRoi)}
            </div>
          </div>
        </section>
      )}

      {pickResults.length > 0 && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm p-4 mb-4 dark:bg-amber-950 dark:border-amber-900">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-amber-500 text-white px-2 py-0.5 rounded-full">
                厳選レース
              </span>
              <span className="text-xs text-amber-800 dark:text-amber-400">{formatDateStr(viewDate)}の結果</span>
            </div>
            {pickFinished.length > 0 && (
              <span className="text-xs font-semibold text-amber-900 dark:text-amber-300">
                {pickHits}/{pickFinished.length}的中 ・{" "}
                <span className={(pickRoi ?? 0) >= 100 ? "text-green-700 dark:text-green-400" : ""}>
                  {pickRoi?.toFixed(1)}%
                </span>
              </span>
            )}
          </div>
          <ul className="flex flex-col divide-y divide-amber-100 dark:divide-amber-900">
            {pickResults.map((r) => {
              const notation = r.pick.formation ? formatFormationNotation(r.pick.formation) : null;
              return (
                <li key={r.pick.race_id} className="py-1.5">
                  <Link
                    href={`/races/${r.pick.race_id}/bets`}
                    className="flex items-center gap-2 active:bg-amber-100/50 -mx-1 px-1 rounded text-sm dark:active:bg-amber-900/50"
                  >
                    <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                      {r.pick.start_time ?? "--:--"}
                    </span>
                    <span className="text-gray-900 w-20 shrink-0 truncate dark:text-gray-100">
                      {r.pick.keirinjo_name}
                      {r.pick.race_no}R
                    </span>
                    <span className="flex-1 font-mono text-xs text-gray-600 truncate dark:text-gray-400">
                      {notation ?? "-"}
                    </span>
                    {!r.finished ? (
                      <span className="text-xs text-gray-400 shrink-0 dark:text-gray-500">結果未確定</span>
                    ) : (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                          r.hit
                            ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                            : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                        }`}
                      >
                        {r.hit ? "的中" : "不的中"}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {barikataResults.length > 0 && (
        <section className="bg-rose-50 border border-rose-200 rounded-lg shadow-sm p-4 mb-4 dark:bg-rose-950 dark:border-rose-900">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-rose-600 text-white px-2 py-0.5 rounded-full">
                バリカタ
              </span>
              <span className="text-xs text-rose-800 dark:text-rose-400">{formatDateStr(viewDate)}の結果</span>
            </div>
            {barikataFinished.length > 0 && (
              <span className="text-xs font-semibold text-rose-900 dark:text-rose-300">
                {barikataHits}/{barikataFinished.length}的中 ・{" "}
                <span className={(barikataRoi ?? 0) >= 100 ? "text-green-700 dark:text-green-400" : ""}>
                  {barikataRoi?.toFixed(1)}%
                </span>
              </span>
            )}
          </div>
          <ul className="flex flex-col divide-y divide-rose-100 dark:divide-rose-900">
            {barikataResults.map((r) => (
              <li key={r.pick.race_id} className="py-1.5">
                <Link
                  href={`/races/${r.pick.race_id}/bets`}
                  className="flex items-center gap-2 active:bg-rose-100/50 -mx-1 px-1 rounded text-sm dark:active:bg-rose-900/50"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                    {r.pick.start_time ?? "--:--"}
                  </span>
                  <span className="text-gray-900 w-20 shrink-0 truncate dark:text-gray-100">
                    {r.pick.keirinjo_name}
                    {r.pick.race_no}R
                  </span>
                  <span className="flex-1 font-mono font-bold text-rose-700 text-xs dark:text-rose-400">
                    {r.pick.combo}
                  </span>
                  {!r.finished ? (
                    <span className="text-xs text-gray-400 shrink-0 dark:text-gray-500">結果未確定</span>
                  ) : (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                        r.hit
                          ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                          : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                      }`}
                    >
                      {r.hit ? "的中" : "不的中"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4 dark:bg-gray-800">
        <h2 className="font-semibold text-sm text-gray-600 mb-2 dark:text-gray-300">
          直近の成績（結果確定分 {stats.totalRaces}レース・ガールズ除く）
        </h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm dark:text-gray-200">
          <div>◎ 単勝的中率</div>
          <div className="text-right tabular-nums">{fmtPct(stats.honmeiHitRate)}</div>
          <div>◎ 複勝的中率（3着以内）</div>
          <div className="text-right tabular-nums">{fmtPct(stats.honmeiTop3Rate)}</div>
          <div>3連単フォーメーション的中率</div>
          <div className="text-right tabular-nums">{fmtPct(stats.sanrentanHitRate)}</div>
          <div>回収率（参考値）</div>
          <div className="text-right tabular-nums">{fmtPct(stats.overallRoi)}</div>
        </div>
        <p className="text-xs text-gray-400 mt-2 dark:text-gray-500">
          回収率はフォーメーション各点に100円均等買いした場合の参考値。オッズは予想記録時点のスナップショットで、公式の確定払戻金とは異なる場合がある。
        </p>
      </section>

      {summaries.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8 dark:text-gray-500">
          まだ記録された予想がありません。レース詳細画面で「この予想を記録する」を押すと、ここに表示されます。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {summaries.map((s) => {
            const resolved = s.honmeiHit != null;
            return (
              <Link
                key={s.race.id}
                href={`/races/${s.race.id}`}
                className="bg-white rounded-lg shadow-sm p-3 flex items-center justify-between active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
              >
                <div>
                  <div className="font-medium text-sm flex items-center gap-1.5 dark:text-gray-100">
                    {formatDate(s.race.kaisai_date)} {s.race.keirinjo_name} {s.race.race_no}R
                    {s.isGirlsRace && (
                      <span className="text-[10px] font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded dark:bg-purple-950 dark:text-purple-400">
                        ガールズ
                      </span>
                    )}
                  </div>
                  {!resolved ? (
                    <div className="text-xs text-gray-400 dark:text-gray-500">結果未確定</div>
                  ) : (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      ◎{s.honmeiHit ? "単勝的中" : s.honmeiTop3 ? "複勝止まり" : "不的中"} /
                      3連単{s.sanrentanHit ? "的中" : "不的中"}
                      {s.roi != null ? ` / 回収率${s.roi.toFixed(0)}%` : ""}
                    </div>
                  )}
                </div>
                {resolved && (
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-semibold ${
                      s.honmeiHit
                        ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                        : s.honmeiTop3
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                          : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                    }`}
                  >
                    {s.honmeiHit ? "的中" : s.honmeiTop3 ? "惜しい" : "不的中"}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
