// calculateBankFitScore（lib/scoring.ts）が実際に参照している開催場ごとの
// 決まり手データ（逃げ/捲り/差しの1着割合）をそのまま表示するカード。
// 優先順位（自場実績→同周長グループ実績→bank_info静的値）は呼び出し側で解決済みの
// 値を渡してもらう（venues/[jocd]・races/[id]/bets の両方で同じ解決ロジックを使う）。
export interface BankKimariteRates {
  nige_pct: number;
  makuri_pct: number;
  sashi_pct: number;
}

export function BankKimariteCard({
  rates,
  sourceLabel,
  featureText,
}: {
  rates: BankKimariteRates;
  sourceLabel: string | null;
  featureText?: string | null;
}) {
  return (
    <section className="bg-white rounded-lg shadow-sm p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-gray-600">このバンクの決まり手傾向</h2>
        {sourceLabel && <span className="text-[10px] text-gray-400">{sourceLabel}</span>}
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
        <div style={{ width: `${rates.nige_pct}%` }} className="bg-sky-400" />
        <div style={{ width: `${rates.makuri_pct}%` }} className="bg-amber-400" />
        <div style={{ width: `${rates.sashi_pct}%` }} className="bg-rose-400" />
      </div>
      <div className="flex justify-between mt-2 text-xs text-gray-600">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-sky-400" />
          逃げ {rates.nige_pct.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
          捲り {rates.makuri_pct.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-rose-400" />
          差し {rates.sashi_pct.toFixed(0)}%
        </span>
      </div>
      {featureText && <p className="text-xs text-gray-400 mt-2 leading-relaxed">{featureText}</p>}
    </section>
  );
}
