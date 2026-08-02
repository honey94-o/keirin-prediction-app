export function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-gray-500">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-gray-200 overflow-hidden">
        <div className="h-full bg-[#0d5c3f]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums text-gray-700">{Math.round(pct)}</span>
    </div>
  );
}
