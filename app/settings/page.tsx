import Link from "next/link";
import { getScoreWeights, getFavoriteRacers } from "../../lib/repository";
import { toggleFavoriteRacerAction } from "../../lib/actions";
import { WeightSettingsForm } from "../../components/WeightSettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const weights = await getScoreWeights();
  const favorites = await getFavoriteRacers();

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-1 dark:text-gray-100">設定</h1>
      <p className="text-sm text-gray-500 mb-4 dark:text-gray-400">
        3本柱（ライン／脚質実力／データ統計）の重みを調整します。保存すると次に開く予想画面から反映されます。
      </p>
      <section className="bg-white rounded-lg shadow-sm p-4 mb-4 dark:bg-gray-800">
        <WeightSettingsForm initialWeights={weights} />
      </section>

      <section className="bg-white rounded-lg shadow-sm p-4 dark:bg-gray-800">
        <h2 className="font-semibold mb-2 text-sm text-gray-600 dark:text-gray-300">
          お気に入り選手{favorites.length > 0 ? `（${favorites.length}名）` : ""}
        </h2>
        {favorites.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">
            まだ登録がありません。選手ページの「☆ お気に入り登録」から登録できます。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-100 dark:divide-gray-700">
            {favorites.map((racer) => {
              const removeFavorite = toggleFavoriteRacerAction.bind(null, racer.snum, true);
              return (
                <li key={racer.snum} className="flex items-center gap-2 py-2">
                  <Link
                    href={`/racers/${racer.snum}`}
                    className="flex-1 text-sm text-gray-900 truncate dark:text-gray-100"
                  >
                    {racer.name}
                    <span className="text-xs text-gray-400 ml-1 dark:text-gray-500">
                      {racer.pref ?? "-"} / {racer.class_rank ?? "-"}
                    </span>
                  </Link>
                  <form action={removeFavorite}>
                    <button
                      type="submit"
                      className="text-xs text-gray-400 px-2 py-1 rounded active:bg-gray-100 dark:text-gray-500 dark:active:bg-gray-700"
                    >
                      解除
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
