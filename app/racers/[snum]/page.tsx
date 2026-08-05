import { notFound } from "next/navigation";
import { getRacer, getRacerHistory, getPositionWinRates } from "../../../lib/repository";
import { determineClassChange } from "../../../lib/scoring";

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
  const classChange = determineClassChange(racer);

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-1">{racer.name}</h1>
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
            <div>1000mTT</div>
            <div className="text-right tabular-nums">
              {racer.tt1000_sec != null ? `${racer.tt1000_sec.toFixed(2)}秒` : "不明"}
            </div>
            <div>3000mTT</div>
            <div className="text-right tabular-nums">
              {racer.tt3000_sec != null ? `${racer.tt3000_sec.toFixed(2)}秒` : "不明"}
            </div>
          </div>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm p-4 mb-4">
        <h2 className="font-semibold mb-2 text-sm text-gray-600">
          隊列内位置別勝率
          <span className="text-xs text-gray-400 font-normal ml-2">
            自前集計・母数が少ないうちは参考程度
          </span>
        </h2>
        {positionWinRates.length === 0 ? (
          <p className="text-sm text-gray-400">まだデータがありません（結果の蓄積が必要）</p>
        ) : (
          <div className="grid grid-cols-3 gap-y-2 text-sm">
            {positionWinRates.map((p) => (
              <div key={p.line_position} className="contents">
                <div>{p.line_position}</div>
                <div className="text-right tabular-nums">{p.winRate.toFixed(0)}%</div>
                <div className="text-right text-gray-400">
                  {p.wins}/{p.races}走
                </div>
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
