"use client";

import { useState } from "react";
import Link from "next/link";
import { MarkBadge } from "./MarkBadge";
import { CarNumberBadge } from "./CarNumberBadge";
import { formatFormationNotation } from "../lib/scoring";
import type { RacePrediction } from "../lib/predict";
import type { DailyPickRow } from "../lib/types";

interface PickItem {
  pick: DailyPickRow;
  prediction: RacePrediction;
}

// 「厳選レース」10件を発走時刻順のタブで切り替えて見られるようにするクライアント
// コンポーネント。/races/[id]/betsへページ遷移せずに、その日の推奨買い目
// （本命フォーメーション）を1画面で次々確認できるようにする。
export function PicksTabs({ items }: { items: PickItem[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = items[Math.min(activeIndex, items.length - 1)];
  const { pick, prediction } = active;
  const { race, scored, scenarios } = prediction;
  const honmeiScenario = scenarios.find((s) => s.label === "本命");
  const notation = honmeiScenario ? formatFormationNotation(honmeiScenario.formation.combinations) : null;
  const top4 = scored.slice(0, 4);

  return (
    <div>
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 -mx-4 px-4">
        {items.map((item, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={item.pick.race_id}
              onClick={() => setActiveIndex(i)}
              className={`shrink-0 flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                isActive
                  ? "bg-[#0d5c3f] text-white"
                  : "bg-white text-gray-600 border border-gray-200 active:bg-gray-50"
              }`}
            >
              <span className="tabular-nums">{item.pick.start_time ?? "--:--"}</span>
              <span className="whitespace-nowrap">
                {item.pick.keirinjo_name}
                {item.pick.race_no}R
              </span>
            </button>
          );
        })}
      </div>

      <section className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="font-bold text-base">
            {race.keirinjo_name} {race.race_no}R
          </h2>
          <span className="text-sm text-gray-400 tabular-nums">発走 {race.start_time ?? "--:--"}</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">本命との差 {pick.margin.toFixed(1)}点</p>

        <div className="flex gap-2 mb-4 flex-wrap">
          {top4.map((s) => (
            <div
              key={s.entry.entry_id}
              className="flex items-center gap-1 bg-gray-50 rounded-full pl-1 pr-2 py-1"
            >
              <MarkBadge mark={s.mark} />
              <CarNumberBadge carNum={s.entry.car_num} size="sm" />
              <span className="text-sm">{s.entry.name}</span>
            </div>
          ))}
        </div>

        {honmeiScenario && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold bg-[#0d5c3f] text-white px-2 py-0.5 rounded-full">
                本命
              </span>
              <span className="text-xs text-gray-400 ml-auto">
                {honmeiScenario.formation.combinations.length}点
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-3">{honmeiScenario.reason}</p>

            {notation && (
              <>
                <p className="text-2xl font-bold tabular-nums font-mono text-[#0d5c3f] mb-1">{notation}</p>
                <p className="text-xs text-gray-400 mb-3">
                  軸-2着候補-3着候補（車番を連結表記。車券購入時にそのまま入力可能）
                </p>
              </>
            )}

            <div className="flex flex-wrap gap-2 mb-4">
              {honmeiScenario.formation.combinations.map((combo) => (
                <span
                  key={combo}
                  className="px-2 py-1 rounded bg-gray-100 text-sm tabular-nums font-mono"
                >
                  {combo}
                </span>
              ))}
            </div>
          </>
        )}

        <Link href={`/races/${race.id}/bets`} className="text-sm text-[#0d5c3f] underline">
          他のシナリオ・出走表を見る →
        </Link>
      </section>

      <div className="flex justify-between mt-3">
        <button
          onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
          disabled={activeIndex === 0}
          className="text-sm text-[#0d5c3f] px-3 py-1.5 disabled:text-gray-300"
        >
          ← 前のレース
        </button>
        <span className="text-xs text-gray-400 self-center">
          {activeIndex + 1} / {items.length}
        </span>
        <button
          onClick={() => setActiveIndex((i) => Math.min(items.length - 1, i + 1))}
          disabled={activeIndex === items.length - 1}
          className="text-sm text-[#0d5c3f] px-3 py-1.5 disabled:text-gray-300"
        >
          次のレース →
        </button>
      </div>
    </div>
  );
}
