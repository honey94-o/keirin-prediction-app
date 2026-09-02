// 直近成績（好調・不調の波）の簡易表示。calculateRecentFormScore（lib/scoring.ts）の
// avgFinish（直近3イベントの平均着順、1着=1.0〜）をそのまま閾値判定に使う。
// はっきりしたケースだけ表示し、中間はバッジなし（何も返さない）。
const HOT_THRESHOLD = 3.0;
const COLD_THRESHOLD = 5.0;

export function RecentFormBadge({ avgFinish }: { avgFinish: number | null }) {
  if (avgFinish == null) return null;
  if (avgFinish <= HOT_THRESHOLD) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-red-50 text-red-600 px-1.5 py-0.5 rounded-full shrink-0">
        🔥好調
      </span>
    );
  }
  if (avgFinish >= COLD_THRESHOLD) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full shrink-0">
        📉不調
      </span>
    );
  }
  return null;
}
