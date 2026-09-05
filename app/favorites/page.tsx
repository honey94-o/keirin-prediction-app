import Link from "next/link";
import { getFavoriteRacers, getFavoriteRacerEntriesForDate } from "../../lib/repository";
import { todayJstStr, formatDateStr } from "../../lib/date";
import { yesterdayJst } from "../../lib/accuracy";
import type { FavoriteRacerEntry } from "../../lib/types";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  const todayStr = todayJstStr();
  const yesterdayStr = yesterdayJst();

  const [favorites, todayEntries, yesterdayEntries] = await Promise.all([
    getFavoriteRacers(),
    getFavoriteRacerEntriesForDate(todayStr),
    getFavoriteRacerEntriesForDate(yesterdayStr),
  ]);

  const todayBySnum = new Map<string, FavoriteRacerEntry[]>();
  for (const e of todayEntries) {
    const arr = todayBySnum.get(e.snum) ?? [];
    arr.push(e);
    todayBySnum.set(e.snum, arr);
  }
  const yesterdayBySnum = new Map<string, FavoriteRacerEntry[]>();
  for (const e of yesterdayEntries) {
    const arr = yesterdayBySnum.get(e.snum) ?? [];
    arr.push(e);
    yesterdayBySnum.set(e.snum, arr);
  }

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href="/" className="text-sm text-[#0d5c3f] mb-2 inline-block dark:text-emerald-400">
        ← ホームに戻る
      </Link>
      <h1 className="text-lg font-bold mb-1 dark:text-gray-100">お気に入り選手</h1>
      <p className="text-sm text-gray-400 mb-4 dark:text-gray-500">
        {favorites.length}名登録中。選手ページの「☆ お気に入り登録」で追加・解除できます。
      </p>

      {favorites.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8 dark:text-gray-500">
          まだ登録がありません。選手ページから登録してください。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {favorites.map((racer) => {
            const todays = todayBySnum.get(racer.snum) ?? [];
            const yesterdays = yesterdayBySnum.get(racer.snum) ?? [];
            return (
              <section key={racer.snum} className="bg-white rounded-lg shadow-sm p-4 dark:bg-gray-800">
                <div className="flex items-baseline justify-between mb-2">
                  <Link
                    href={`/racers/${racer.snum}`}
                    className="font-semibold text-gray-900 dark:text-gray-100"
                  >
                    {racer.name}
                  </Link>
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {racer.pref ?? "-"} / {racer.class_rank ?? "-"}
                  </span>
                </div>

                <div className="mb-2">
                  <div className="text-xs text-gray-500 mb-1 dark:text-gray-400">
                    昨日（{formatDateStr(yesterdayStr)}）の結果
                  </div>
                  {yesterdays.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500">出走なし</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {yesterdays.map((e) => (
                        <li key={e.race.id} className="flex items-center gap-2 text-sm">
                          <Link
                            href={`/races/${e.race.id}/bets`}
                            className="flex-1 truncate text-gray-700 dark:text-gray-300"
                          >
                            {e.race.keirinjo_name}
                            {e.race.race_no}R
                          </Link>
                          {e.finishPos != null ? (
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                                e.finishPos === 1
                                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                                  : e.finishPos <= 3
                                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                                    : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                              }`}
                            >
                              {e.finishPos}着{e.finishPos === 1 && e.kimarite ? `（${e.kimarite}）` : ""}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400 dark:text-gray-500">結果未確定</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <div className="text-xs text-gray-500 mb-1 dark:text-gray-400">
                    本日（{formatDateStr(todayStr)}）の出走
                  </div>
                  {todays.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500">出走なし</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {todays.map((e) => (
                        <li key={e.race.id}>
                          <Link
                            href={`/races/${e.race.id}/bets`}
                            className="flex items-center gap-2 text-sm bg-yellow-50 rounded px-2 py-1.5 active:bg-yellow-100 dark:bg-yellow-950 dark:active:bg-yellow-900"
                          >
                            <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                              {e.race.start_time ?? "--:--"}
                            </span>
                            <span className="flex-1 truncate text-gray-900 dark:text-gray-100">
                              {e.race.keirinjo_name}
                              {e.race.race_no}R
                            </span>
                            <span className="text-xs text-yellow-700 tabular-nums dark:text-yellow-400">
                              {e.carNum}番
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
