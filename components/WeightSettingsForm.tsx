"use client";

import { useState } from "react";
import { updateWeightsAction } from "../lib/actions";
import type { ScoreWeights } from "../lib/types";

export function WeightSettingsForm({ initialWeights }: { initialWeights: ScoreWeights }) {
  // スライダーは0-100の生値で扱い、送信時に合計1へ正規化する
  const [line, setLine] = useState(Math.round(initialWeights.line * 100));
  const [kyakushitsu, setKyakushitsu] = useState(
    Math.round(initialWeights.kyakushitsu * 100)
  );
  const [stats, setStats] = useState(Math.round(initialWeights.stats * 100));
  const [saved, setSaved] = useState(false);

  const sum = line + kyakushitsu + stats || 1;
  const pct = (v: number) => ((v / sum) * 100).toFixed(0);

  return (
    <form
      action={async (formData) => {
        await updateWeightsAction(formData);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }}
      className="flex flex-col gap-5"
    >
      <SliderRow label="① ライン" value={line} onChange={setLine} normalizedPct={pct(line)} name="line" />
      <SliderRow
        label="② 脚質実力"
        value={kyakushitsu}
        onChange={setKyakushitsu}
        normalizedPct={pct(kyakushitsu)}
        name="kyakushitsu"
      />
      <SliderRow
        label="③ データ統計"
        value={stats}
        onChange={setStats}
        normalizedPct={pct(stats)}
        name="stats"
      />

      <p className="text-xs text-gray-400 dark:text-gray-500">
        3つの比率で正規化されるため、合計が100でなくても構いません。
      </p>

      <button
        type="submit"
        className="bg-[#0d5c3f] text-white rounded-lg py-2 font-semibold active:opacity-80"
      >
        {saved ? "保存しました" : "保存する"}
      </button>
    </form>
  );
}

function SliderRow({
  label,
  value,
  onChange,
  normalizedPct,
  name,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  normalizedPct: string;
  name: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span className="font-medium dark:text-gray-100">{label}</span>
        <span className="tabular-nums text-gray-500 dark:text-gray-400">{normalizedPct}%</span>
      </div>
      <input
        type="range"
        name={name}
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#0d5c3f]"
      />
    </label>
  );
}
