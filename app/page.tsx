import Link from "next/link";
import {
  getRacesByDate,
  getDailyPicks,
  getBarikataPicks,
  getLastSyncedAt,
  getFavoriteRacerEntriesForDate,
  getFavoriteRacers,
  getResultsForRaces,
} from "../lib/repository";
import {
  todayJstStr,
  addDaysToDateStr,
  formatDateStr,
  isValidDateStr,
  formatUtcAsJst,
  nowJstHHMM,
  parseEncp,
} from "../lib/date";
import { RefreshTrigger } from "../components/RefreshTrigger";
import { raceStage } from "../lib/scoring";
import type { RaceRow, ResultRow } from "../lib/types";

// GitHub Actions（daily-sync.yml、1日2回自動実行）がNext.jsの外からTursoを
// 直接更新するため、ビルド時の静的生成のままだと新しいレースが反映されない。
// 常に最新のDBを読むよう動的レンダリングを強制する。
export const dynamic = "force-dynamic";

/**
 * 開催場カードから買い目提案画面へ直接飛ぶ先のレースを選ぶ。
 * 当日ならまだ発走していない一番近いレース（無ければ最終レース）、
 * 翌日以降なら最初のレース、前日以前なら最終レースを返す
 * （「今行くならどのレースを見たいか」に合わせた素朴な既定値）。
 */
function pickNearestRace(groupRaces: RaceRow[], viewDate: string, todayStr: string): RaceRow {
  const sorted = [...groupRaces].sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
  if (viewDate === todayStr) {
    const now = nowJstHHMM();
    const upcoming = sorted.find((r) => (r.start_time ?? "") >= now);
    return upcoming ?? sorted[sorted.length - 1];
  }
  if (viewDate > todayStr) return sorted[0];
  return sorted[sorted.length - 1];
}

/**
 * 開催の何日目かを表示用ラベルにする。1日目は「初日」、その日に決勝レースが
 * 含まれるなら「最終日」（決勝は必ず開催最終日に組まれるため）、それ以外は「N日目」。
 * 翌日分のレース有無では判定しない――daily-syncは基本的に当日分しか事前取得しない
 * ため、日中に見ると翌日データが未取得で常に「最終日」になってしまう。
 */
/** 着順が3人分以上確定していればそのレースは終了とみなす（bets画面のraceFinishedと同じ基準）。 */
function isRaceFinished(raceId: number, resultsByRaceId: Map<number, ResultRow[]>): boolean {
  const results = resultsByRaceId.get(raceId) ?? [];
  return results.filter((r) => r.finish_pos != null).length >= 3;
}

function eventDayLabel(groupRaces: RaceRow[]): string | null {
  const parsed = groupRaces.map((r) => parseEncp(r.encp)).find((p) => p != null);
  if (!parsed) return null;
  const hasFinalToday = groupRaces.some((r) => raceStage(r.syumoku) === "決勝");
  if (hasFinalToday) return "最終日";
  if (parsed.day === 1) return "初日";
  return `${parsed.day}日目`;
}

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
  // 開催場カードを「本日終了」でグレーアウトするための判定に使う（1クエリで全レース分まとめて取得）。
  const resultsByRaceId = await getResultsForRaces(races.map((r) => r.id));

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

  // 「お気に入り選手のレース」：選択中の日（前日/当日/翌日タブと連動）に
  // お気に入り登録済みの選手が出走するレースを発走時刻順に表示する。
  const favoriteEntries = await getFavoriteRacerEntriesForDate(viewDate);
  // レースが無い日でも/favoritesへの入口は出しておきたいので、登録数だけ別途取得する。
  const favoriteRacers = await getFavoriteRacers();

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

      {favoriteRacers.length > 0 && (
        <section className="bg-yellow-50 border border-yellow-200 rounded-lg shadow-sm p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-yellow-500 text-white px-2 py-0.5 rounded-full">
                ★ お気に入り
              </span>
              <span className="text-xs text-yellow-800">{formatDateStr(viewDate)}の出走</span>
            </div>
            <Link href="/favorites" className="text-xs font-semibold text-yellow-800 underline whitespace-nowrap">
              一覧を見る →
            </Link>
          </div>
          {favoriteEntries.length === 0 ? (
            <p className="text-xs text-gray-400">この日の出走はありません</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {favoriteEntries.map((f) => (
                <li key={`${f.race.id}-${f.snum}`}>
                  <Link
                    href={`/races/${f.race.id}/bets`}
                    className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50"
                  >
                    <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0">
                      {f.race.start_time ?? "--:--"}
                    </span>
                    <span className="text-sm text-gray-900 flex-1 truncate">
                      {f.race.keirinjo_name} {f.race.race_no}R
                    </span>
                    <span className="text-xs text-yellow-700 tabular-nums shrink-0">{f.carNum}番</span>
                    <span className="text-sm font-semibold text-gray-900 truncate max-w-[8rem]">
                      {f.racerName}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
            const nearestRace = pickNearestRace(groupRaces, viewDate, todayStr);
            const allFinished = groupRaces.every((r) => isRaceFinished(r.id, resultsByRaceId));
            return (
              <Link
                key={jocd}
                href={`/races/${nearestRace.id}/bets`}
                className={`flex items-center justify-between rounded-lg shadow-sm px-4 py-3 ${
                  allFinished ? "bg-gray-100 active:bg-gray-200" : "bg-white active:bg-gray-50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`font-semibold ${allFinished ? "text-gray-400" : "text-gray-900"}`}>
                    {first.keirinjo_name}
                  </span>
                  {(() => {
                    const dayLabel = eventDayLabel(groupRaces);
                    if (!dayLabel) return null;
                    return (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          dayLabel === "最終日"
                            ? "bg-rose-50 text-rose-600"
                            : "bg-sky-50 text-sky-700"
                        }`}
                      >
                        {dayLabel}
                      </span>
                    );
                  })()}
                  {first.grade_kbn && (
                    <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                      {first.grade_kbn}
                    </span>
                  )}
                  {(() => {
                    const stage = raceStage(nearestRace.syumoku);
                    if (stage === "不明") return null;
                    return (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          stage === "予選"
                            ? "bg-gray-100 text-gray-500"
                            : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {stage}
                      </span>
                    );
                  })()}
                  {allFinished && (
                    <span className="text-[10px] font-semibold bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">
                      終了
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <div className={`text-sm ${allFinished ? "text-gray-400" : "text-gray-500"}`}>
                    {allFinished
                      ? `全${groupRaces.length}レース終了`
                      : `${groupRaces.length}レース中 ${nearestRace.race_no}R`}
                  </div>
                  {!allFinished && nearestRace.start_time && (
                    <div className="text-xs text-gray-400">発走 {nearestRace.start_time}</div>
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
