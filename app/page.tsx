import Link from "next/link";
import { getRacesByDate, getDailyPicks, getBarikataPicks, getLastSyncedAt } from "../lib/repository";
import { todayJstStr, addDaysToDateStr, formatDateStr, isValidDateStr, formatUtcAsJst } from "../lib/date";
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
  const lastSyncedAt = await getLastSyncedAt();

  // 「本日の厳選レース」：結果未確定（前日以前は対象外）の日だけ、
  // scripts/daily-picks.tsが事前計算したdaily_picksからその日の本命marginが
  // 大きい順に上位10件を表示する。scripts/simulate-selective-strategy.tsで
  // 122日分の実データを検証した結果、margin自体にしきい値を設けるより
  // 「その日の中での相対的な上位」を機械的に選ぶ方が、1日の採用件数を安定して
  // 確保しつつ30日ローリング回収率も安定した（詳細はgetDailyPicksのコメント参照）。
  const showPicks = viewDate === todayStr || viewDate === nextDate;
  const picks = showPicks ? await getDailyPicks(viewDate) : [];
  // ホーム画面のプレビュー一覧は発走時刻順に並べ替える（時刻がバラバラなので
  // 時系列で見えた方が分かりやすい。タブ切り替え版は/picksで発走順に見られる）。
  const picksByTime = [...picks].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  // 「本日のバリカタ」：margin>=8かつ予想1-2-3位が同ラインのレースを1日最大3件。
  // 厳選（フォーメーション買い）とは別枠で、単一の並び（1点）を想定した高的中率
  // 狙いのピック。scripts/barikata-picks.tsのコメント参照。
  const barikataPicks = showPicks ? await getBarikataPicks(viewDate) : [];
  const barikataByTime = [...barikataPicks].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  const groups = new Map<string, RaceRow[]>();
  for (const race of races) {
    if (!groups.has(race.jocd)) groups.set(race.jocd, []);
    groups.get(race.jocd)!.push(race);
  }
  // 開催場一覧は取得順（keirinjo_name あいうえお順）のままだと発走順にならないため、
  // 各開催場の最初のレースの発走時刻順に並べ替える。
  const groupsByTime = [...groups.entries()].sort(([, a], [, b]) =>
    (a[0].start_time ?? "").localeCompare(b[0].start_time ?? "")
  );

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
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm text-gray-400">{formatDateStr(viewDate)}</p>
        {lastSyncedAt && (
          <p className="text-xs text-gray-400">最終更新 {formatUtcAsJst(lastSyncedAt)}</p>
        )}
      </div>

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

      {barikataPicks.length > 0 && (
        <section className="bg-rose-50 border border-rose-200 rounded-lg shadow-sm p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold bg-rose-600 text-white px-2 py-0.5 rounded-full">
              バリカタ
            </span>
            <span className="text-xs text-rose-800">
              margin・ライン決着から絞った単一の並び（1点買い想定）
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {barikataByTime.map((p) => (
              <li key={p.race_id}>
                <Link
                  href={`/races/${p.race_id}/bets`}
                  className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0">
                    {p.start_time ?? "--:--"}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate">
                    {p.keirinjo_name} {p.race_no}R
                  </span>
                  <span className="text-sm font-mono font-bold text-rose-700 tabular-nums whitespace-nowrap">
                    {p.combo}
                  </span>
                  <span className="text-xs font-semibold text-rose-700 tabular-nums whitespace-nowrap">
                    差{p.margin.toFixed(1)}点
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-rose-700 mt-2 leading-relaxed">
            単一の並び的中率は検証時点で32.7%・的中時平均オッズ4.13倍（1点買い回収率約140%、母数197件）。
            必ず的中するわけではありません。
          </p>
        </section>
      )}

      {picks.length > 0 && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-amber-500 text-white px-2 py-0.5 rounded-full">
                厳選レース
              </span>
              <span className="text-xs text-amber-800">本命の信頼度が高い上位{picks.length}レース</span>
            </div>
            <Link
              href={`/picks?date=${viewDate}`}
              className="text-xs font-semibold text-amber-800 underline whitespace-nowrap"
            >
              タブでまとめて見る →
            </Link>
          </div>
          <ul className="flex flex-col gap-2">
            {picksByTime.map((p) => (
              <li key={p.race_id}>
                <Link
                  href={`/races/${p.race_id}/bets`}
                  className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0">
                    {p.start_time ?? "--:--"}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate">
                    {p.keirinjo_name} {p.race_no}R
                  </span>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    軸 {p.honmei_car_num}.{p.honmei_name}
                  </span>
                  <span className="text-xs font-semibold text-amber-700 tabular-nums whitespace-nowrap">
                    差{p.margin.toFixed(1)}点
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

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
          {groupsByTime.map(([jocd, groupRaces]) => {
            const first = groupRaces[0];
            return (
              <Link
                key={jocd}
                href={`/venues/${jocd}?date=${viewDate}`}
                className="flex items-center justify-between bg-white rounded-lg shadow-sm px-4 py-3 active:bg-gray-50"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-gray-900">{first.keirinjo_name}</span>
                  {first.grade_kbn && (
                    <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                      {first.grade_kbn}
                    </span>
                  )}
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
