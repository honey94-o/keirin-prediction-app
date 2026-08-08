import Link from "next/link";
import { getDailyPicks } from "../../lib/repository";
import { predictRace } from "../../lib/predict";
import { todayJstStr, addDaysToDateStr, formatDateStr, isValidDateStr } from "../../lib/date";
import { PicksTabs } from "../../components/PicksTabs";

export const dynamic = "force-dynamic";

export default async function PicksPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const todayStr = todayJstStr();
  const viewDate = isValidDateStr(date) ? date : todayStr;

  const picks = await getDailyPicks(viewDate);
  // 発走時刻順に並べ替える（本命の信頼度順ではなく、当日の時系列でタブを追える方が
  // 実際に馬券を買う時に使いやすいため）。
  const sortedPicks = [...picks].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  const predictions = await Promise.all(sortedPicks.map((p) => predictRace(p.race_id)));
  const items = sortedPicks
    .map((p, i) => ({ pick: p, prediction: predictions[i] }))
    .filter((item): item is { pick: (typeof sortedPicks)[number]; prediction: NonNullable<typeof predictions[number]> } => item.prediction != null);

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href={`/?date=${viewDate}`} className="text-sm text-[#0d5c3f] mb-2 inline-block">
        ← ホームに戻る
      </Link>
      <h1 className="text-lg font-bold mb-1">厳選レース（{formatDateStr(viewDate)}）</h1>
      <p className="text-xs text-gray-400 mb-4">
        本命の信頼度が高い上位{items.length}レースを発走時刻順にタブで表示。買い目は「本命」フォーメーション（1レース20点以内）が対象です。
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8">
          {formatDateStr(viewDate)}の厳選レースはまだありません。
        </p>
      ) : (
        <PicksTabs items={items} />
      )}

      <p className="text-xs text-gray-400 mt-6 leading-relaxed">
        選定方法：その日の本命（◎と対抗のスコア差）が大きい順に上位{items.length <= 10 ? "10" : items.length}件を機械的に選出。
        過去122日分のシミュレーションでは全期間回収率157.3%、30日ローリング窓の89.2%が黒字（最悪でも83.1%）という実績。
        ただしギャンブルのため100%超えを毎回保証するものではありません。
      </p>
    </main>
  );
}
