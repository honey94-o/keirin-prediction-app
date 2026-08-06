import Link from "next/link";
import { getRacesByDate } from "../lib/repository";
import { todayJstStr, addDaysToDateStr, formatDateStr, isValidDateStr } from "../lib/date";
import { RefreshTrigger } from "../components/RefreshTrigger";
import type { RaceRow } from "../lib/types";

// GitHub Actions（daily-sync.yml、1日2回自動実行）がNext.jsの外からTursoを
// 直接更新するため、ビルド時の静的生成のままだと新しいレースが反映されない。
// 常に最新のDBを読むよう動的レンダリングを強制する。
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const todayStr = todayJstStr();
  const viewDate = isValidDateStr(date) ? date : todayStr;
  const prevDate = addDaysToDateStr(viewDate, -1);
  const nextDate = addDaysToDateStr(viewDate, 1);

  // 開催場選択（ステップ1）。選択中の1日分のみ表示し、各開催場の件数・発走時刻
  // だけを出す軽量な一覧にしている（予想計算=predictRaceは1レースにつきDBを
  // 20回近く読むため、ここで全レース分まとめて呼ぶと表示が重くなる。予想は
  // レース選択後の詳細画面でだけ計算する）。
  const races = await getRacesByDate(viewDate);

  const groups = new Map<string, RaceRow[]>();
  for (const race of races) {
    if (!groups.has(race.jocd)) groups.set(race.jocd, []);
    groups.get(race.jocd)!.push(race);
  }

  const tabs: { label: string; date: string }[] = [
    { label: "前日", date: prevDate },
    { label: "当日", date: todayStr },
    { label: "翌日", date: nextDate },
  ];

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-lg font-bold">開催場を選択</h1>
        <RefreshTrigger compact />
      </div>
      <p className="text-sm text-gray-400 mb-3">{formatDateStr(viewDate)}</p>

      <div className="flex gap-1.5 mb-4">
        {tabs.map((tab) => {
          const active = tab.date === viewDate;
          const href = tab.date === todayStr ? "/" : `/?date=${tab.date}`;
          return (
            <Link
              key={tab.label}
              href={href}
              className={`flex-1 text-center px-3 py-2 rounded-lg text-sm font-semibold ${
                active
                  ? "bg-[#0d5c3f] text-white"
                  : "bg-white text-gray-600 border border-gray-200"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {races.length === 0 ? (
        <div className="text-center mt-8">
          <p className="text-gray-500 mb-4">
            {formatDateStr(viewDate)}のレースはまだ取得されていません。
            {viewDate === todayStr &&
              "毎日朝5時頃に自動取得されますが、今すぐ取得することもできます。"}
          </p>
          {viewDate <= addDaysToDateStr(todayStr, 1) && <RefreshTrigger />}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {[...groups.entries()].map(([jocd, groupRaces]) => {
            const first = groupRaces[0];
            return (
              <Link
                key={jocd}
                href={`/venues/${jocd}?date=${viewDate}`}
                className="flex items-center justify-between bg-white rounded-lg shadow-sm px-4 py-3 active:bg-gray-50"
              >
                <div className="font-semibold text-gray-900">{first.keirinjo_name}</div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">{groupRaces.length}レース</div>
                  {first.start_time && (
                    <div className="text-xs text-gray-400">発走 {first.start_time}〜</div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
