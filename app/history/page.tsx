import Link from "next/link";
import { getRaceIdsWithPrediction } from "../../lib/repository";
import { getRaceResultSummary, getOverallAccuracyStats } from "../../lib/accuracy";

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

export default async function HistoryPage() {
  const raceIds = await getRaceIdsWithPrediction();
  const summaryResults = await Promise.all(raceIds.map((id) => getRaceResultSummary(id)));
  const summaries = summaryResults.filter((s) => s != null);
  const stats = await getOverallAccuracyStats();

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-4">予想履歴・精度検証</h1>

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
        <h2 className="font-semibold text-sm text-gray-600 mb-2">
          通算成績（結果確定分 {stats.totalRaces}レース）
        </h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <div>◎ 単勝的中率</div>
          <div className="text-right tabular-nums">{fmtPct(stats.honmeiHitRate)}</div>
          <div>◎ 複勝的中率（3着以内）</div>
          <div className="text-right tabular-nums">{fmtPct(stats.honmeiTop3Rate)}</div>
          <div>3連単フォーメーション的中率</div>
          <div className="text-right tabular-nums">{fmtPct(stats.sanrentanHitRate)}</div>
          <div>回収率（参考値）</div>
          <div className="text-right tabular-nums">{fmtPct(stats.overallRoi)}</div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          回収率はフォーメーション各点に100円均等買いした場合の参考値。オッズは予想記録時点のスナップショットで、公式の確定払戻金とは異なる場合がある。
        </p>
      </section>

      {summaries.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8">
          まだ記録された予想がありません。レース詳細画面で「この予想を記録する」を押すと、ここに表示されます。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {summaries.map((s) => {
            if (!s) return null;
            const resolved = s.honmeiHit != null;
            return (
              <Link
                key={s.race.id}
                href={`/races/${s.race.id}`}
                className="bg-white rounded-lg shadow-sm p-3 flex items-center justify-between active:bg-gray-50"
              >
                <div>
                  <div className="font-medium text-sm">
                    {formatDate(s.race.kaisai_date)} {s.race.keirinjo_name} {s.race.race_no}R
                  </div>
                  {!resolved ? (
                    <div className="text-xs text-gray-400">結果未確定</div>
                  ) : (
                    <div className="text-xs text-gray-500">
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
                        ? "bg-red-100 text-red-700"
                        : s.honmeiTop3
                          ? "bg-amber-100 text-amber-700"
                          : "bg-gray-100 text-gray-500"
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
