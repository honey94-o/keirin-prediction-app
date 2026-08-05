import Link from "next/link";
import { getRacesByDate } from "../lib/repository";
import type { RaceRow } from "../lib/types";

// GitHub Actions（daily-sync.yml、1日2回自動実行）がNext.jsの外からTursoを
// 直接更新するため、ビルド時の静的生成のままだと新しいレースが反映されない。
// 常に最新のDBを読むよう動的レンダリングを強制する。
export const dynamic = "force-dynamic";

function formatDate(kaisaiDate: string): string {
  const y = kaisaiDate.slice(0, 4);
  const m = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  return `${y}/${m}/${d}`;
}

export default async function Home() {
  // 開催場選択（ステップ1）。当日開催分のみ表示し、各開催場の件数・発走時刻だけを
  // 出す軽量な一覧にしている（予想計算=predictRaceは1レースにつきDBを20回近く
  // 読むため、ここで全レース分まとめて呼ぶと表示が重くなる。予想はレース選択後の
  // 詳細画面でだけ計算する）。
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const races = await getRacesByDate(todayStr);

  const groups = new Map<string, RaceRow[]>();
  for (const race of races) {
    if (!groups.has(race.jocd)) groups.set(race.jocd, []);
    groups.get(race.jocd)!.push(race);
  }

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-4">開催場を選択</h1>

      {races.length === 0 ? (
        <p className="text-center text-gray-500 mt-8">
          本日のレースはまだ取得されていません。毎日朝6時頃に自動取得されるので、しばらくしてから開き直してください。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {[...groups.entries()].map(([jocd, groupRaces]) => {
            const first = groupRaces[0];
            return (
              <Link
                key={jocd}
                href={`/venues/${jocd}`}
                className="flex items-center justify-between bg-white rounded-lg shadow-sm px-4 py-3 active:bg-gray-50"
              >
                <div>
                  <div className="font-semibold text-gray-900">{first.keirinjo_name}</div>
                  <div className="text-xs text-gray-400">{formatDate(first.kaisai_date)}</div>
                </div>
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
