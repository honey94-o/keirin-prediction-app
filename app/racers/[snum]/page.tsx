import { notFound } from "next/navigation";
import { getRacer, getRacerHistory, getPositionWinRates, isFavoriteRacer } from "../../../lib/repository";
import { determineClassChange } from "../../../lib/scoring";
import { toggleFavoriteRacerAction } from "../../../lib/actions";
import { BackButton } from "../../../components/BackButton";

export default async function RacerDetailPage({
  params,
}: {
  params: Promise<{ snum: string }>;
}) {
  const { snum } = await params;
  const racer = await getRacer(snum);
  if (!racer) notFound();

  const history = await getRacerHistory(snum);
  const positionWinRates = await getPositionWinRates(snum);
  const isFavorite = await isFavoriteRacer(snum);
  const classChange = determineClassChange(racer);
  const toggleFavorite = toggleFavoriteRacerAction.bind(null, snum, isFavorite);

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <BackButton />
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-bold">{racer.name}</h1>
        <form action={toggleFavorite}>
          <button
            type="submit"
            className={`text-xs font-semibold px-3 py-1.5 rounded-full active:opacity-70 ${
              isFavorite ? "bg-yellow-400 text-yellow-900" : "bg-white border border-gray-300 text-gray-500"
            }`}
          >
            {isFavorite ? "★ お気に入り" : "☆ お気に入り登録"}
          </button>
        </form>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        {racer.pref ?? "-"} / {racer.class_rank ?? "-"}
        {racer.prev_class_rank && racer.prev_class_rank !== racer.class_rank
          ? `（前期${racer.prev_class_rank}・${classChange}）`
          : ""}
        {" / 脚質:"}
        {racer.kyakushitsu ?? "-"}
      </p>

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
        <h2 className="font-semibold mb-2 text-sm text-gray-600">通算成績</h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <div>平均得点</div>
          <div className="text-right tabular-nums">{racer.heikin_tokuten ?? "不明"}</div>
          <div>勝率</div>
          <div className="text-right tabular-nums">
            {racer.syouritu != null ? `${racer.syouritu}%` : "不明"}
          </div>
          <div>2連対率</div>
          <div className="text-right tabular-nums">
            {racer.rentairitu2 != null ? `${racer.rentairitu2}%` : "不明"}
          </div>
          <div>3着内率</div>
          <div className="text-right tabular-nums">
            {racer.rentairitu3 != null ? `${racer.rentairitu3}%` : "不明"}
          </div>
          <div>ギア倍数</div>
          <div className="text-right tabular-nums">{racer.gear_ratio ?? "未取得"}</div>
        </div>
      </section>

      {racer.debut_class && (
        <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
          <h2 className="font-semibold mb-2 text-sm text-gray-600">
            記録会データ（{racer.debut_class}・デビュー前）
            <span className="text-xs text-gray-400 font-normal ml-2">
              日本競輪選手養成所調べ・参考値
            </span>
          </h2>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <div>能力別評価</div>
            <div className="text-right font-semibold">{racer.kisokukai_grade ?? "不明"}</div>
            <div>200mTT</div>
            <div className="text-right tabular-nums">
              {racer.tt200_sec != null ? `${racer.tt200_sec.toFixed(2)}秒` : "不明"}
            </div>
            <div>400mTT</div>
            <div className="text-right tabular-nums">
              {racer.tt400_sec != null ? `${racer.tt400_sec.toFixed(2)}秒` : "不明"}
            </div>
            {racer.tt500_sec != null || racer.tt2000_sec != null ? (
              <>
                <div>500mTT</div>
                <div className="text-right tabular-nums">
                  {racer.tt500_sec != null ? `${racer.tt500_sec.toFixed(2)}秒` : "不明"}
                </div>
                <div>2000mTT</div>
                <div className="text-right tabular-nums">
                  {racer.tt2000_sec != null ? `${racer.tt2000_sec.toFixed(2)}秒` : "不明"}
                </div>
              </>
            ) : (
              <>
                <div>1000mTT</div>
                <div className="text-right tabular-nums">
                  {racer.tt1000_sec != null ? `${racer.tt1000_sec.toFixed(2)}秒` : "不明"}
                </div>
                <div>3000mTT</div>
                <div className="text-right tabular-nums">
                  {racer.tt3000_sec != null ? `${racer.tt3000_sec.toFixed(2)}秒` : "不明"}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
        <h2 className="font-semibold mb-2 text-sm text-gray-600">
          隊列内位置別成績
          <span className="text-xs text-gray-400 font-normal ml-2">
            自前集計・母数が少ないうちは参考程度
          </span>
        </h2>
        {positionWinRates.length === 0 ? (
          <p className="text-sm text-gray-400">まだデータがありません（結果の蓄積が必要）</p>
        ) : (
          <div className="grid grid-cols-5 gap-y-2 text-sm">
            <div className="text-xs text-gray-400">位置</div>
            <div className="text-right text-xs text-gray-400">1着</div>
            <div className="text-right text-xs text-gray-400">2着</div>
            <div className="text-right text-xs text-gray-400">3着</div>
            <div className="text-right text-xs text-gray-400">走数</div>
            {positionWinRates.map((p) => (
              <div key={p.line_position} className="contents">
                <div>{p.line_position}</div>
                <div className="text-right tabular-nums">{p.winRate.toFixed(0)}%</div>
                <div className="text-right tabular-nums">{p.secondRate.toFixed(0)}%</div>
                <div className="text-right tabular-nums">{p.thirdRate.toFixed(0)}%</div>
                <div className="text-right text-gray-400">{p.races}走</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-white rounded-lg shadow-sm p-4">
        <h2 className="font-semibold mb-2 text-sm text-gray-600">最近の成績</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400">まだデータがありません</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {history.map((h) => (
              <li key={`${h.race_date}_${h.venue_abbr}`} className="flex justify-between py-1.5">
                <span className="text-gray-500">{h.race_date}</span>
                <span>{h.venue_abbr ?? "-"}</span>
                <span className="tabular-nums">{h.finish_positions || "-"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
