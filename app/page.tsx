import Link from "next/link";
import {
  getRacesByDate,
  getDailyPicksResults,
  getBarikataPicksResults,
  getLastSyncedAt,
  getFavoriteRacerEntriesForDate,
  getFavoriteRacers,
  getResultsForRaces,
  isRaceFinished,
} from "../lib/repository";
import {
  todayJstStr,
  addDaysToDateStr,
  formatDateStr,
  isValidDateStr,
  formatUtcAsJst,
  nowJstHHMM,
  parseEncp,
  minutesBetween,
} from "../lib/date";
import { RefreshTrigger } from "../components/RefreshTrigger";
import { raceStage, pickNearestRace } from "../lib/scoring";
import type { RaceRow } from "../lib/types";

// GitHub Actions（daily-sync.yml、1日2回自動実行）がNext.jsの外からTursoを
// 直接更新するため、ビルド時の静的生成のままだと新しいレースが反映されない。
// 常に最新のDBを読むよう動的レンダリングを強制する。
export const dynamic = "force-dynamic";

/**
 * 開催の何日目かを表示用ラベルにする。1日目は「初日」、その日に決勝レースが
 * 含まれるなら「最終日」（決勝は必ず開催最終日に組まれるため）、それ以外は「N日目」。
 * 翌日分のレース有無では判定しない――daily-syncは基本的に当日分しか事前取得しない
 * ため、日中に見ると翌日データが未取得で常に「最終日」になってしまう。
 */
function eventDayLabel(groupRaces: RaceRow[]): string | null {
  const parsed = groupRaces.map((r) => parseEncp(r.encp)).find((p) => p != null);
  if (!parsed) return null;
  const hasFinalToday = groupRaces.some((r) => raceStage(r.syumoku) === "決勝");
  if (hasFinalToday) return "最終日";
  if (parsed.day === 1) return "初日";
  return `${parsed.day}日目`;
}

/** 発走30分以内なら残り分数を返す（当日タブでのみ意味を持つ）。 */
function startingSoonMinutes(
  startTime: string | null,
  viewDate: string,
  todayStr: string,
  nowHHMM: string
): number | null {
  if (viewDate !== todayStr || !startTime) return null;
  const diff = minutesBetween(nowHHMM, startTime);
  return diff >= 0 && diff <= 30 ? diff : null;
}

function StartingSoonBadge({ minutes }: { minutes: number | null }) {
  if (minutes == null) return null;
  return (
    <span className="text-[10px] font-semibold bg-red-500 text-white px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
      あと{minutes}分
    </span>
  );
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
  // 結果が確定した分は的中/不的中バッジも出したいので、一覧取得と同時に判定
  // 済みのgetDailyPicksResults/getBarikataPicksResultsを使う（内部でgetDailyPicks等を
  // 呼んでいるため、showPicks=falseの日は呼ばず余計なクエリを増やさない）。
  const showPicks = viewDate === todayStr || viewDate === nextDate;
  const pickResults = showPicks ? await getDailyPicksResults(viewDate) : [];
  // ホーム画面のプレビュー一覧は発走時刻順に並べ替える（時刻がバラバラなので
  // 時系列で見えた方が分かりやすい。タブ切り替え版は/picksで発走順に見られる）。
  const picksByTime = [...pickResults].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 「本日のバリカタ」：margin>=8かつ予想1-2-3位が同ラインのレースを1日最大3件。
  // 厳選（フォーメーション買い）とは別枠で、単一の並び（1点）を想定した高的中率
  // 狙いのピック。scripts/barikata-picks.tsのコメント参照。
  const barikataResults = showPicks ? await getBarikataPicksResults(viewDate) : [];
  const barikataByTime = [...barikataResults].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 「お気に入り選手のレース」：選択中の日（前日/当日/翌日タブと連動）に
  // お気に入り登録済みの選手が出走するレースを発走時刻順に表示する。
  const favoriteEntries = await getFavoriteRacerEntriesForDate(viewDate);
  // レースが無い日でも/favoritesへの入口は出しておきたいので、登録数だけ別途取得する。
  const favoriteRacers = await getFavoriteRacers();
  // 「まもなく発走」バッジ判定用（当日タブでのみ意味を持つ）。
  const nowHHMM = nowJstHHMM();

  const groups = new Map<string, RaceRow[]>();
  for (const race of races) {
    if (!groups.has(race.jocd)) groups.set(race.jocd, []);
    groups.get(race.jocd)!.push(race);
  }
  // 開催場一覧は発走時刻順に並べる。ただし当日の全レースが終了した開催場は
  // まだ買い目を確認していない開催場が埋もれないよう、時刻に関係なく末尾に回す。
  const groupsByTime = [...groups.entries()]
    .map(([jocd, groupRaces]) => ({
      jocd,
      groupRaces,
      allFinished: groupRaces.every((r) => isRaceFinished(resultsByRaceId.get(r.id) ?? [])),
    }))
    .sort((a, b) => {
      if (a.allFinished !== b.allFinished) return a.allFinished ? 1 : -1;
      return (a.groupRaces[0].start_time ?? "").localeCompare(b.groupRaces[0].start_time ?? "");
    });

  // 「今日の的中」サマリー：厳選+バリカタの結果確定済み分を合算する。当日タブでのみ
  // 意味を持つ（前日・翌日タブではpickResults/barikataResultsがその日のものになる
  // ため、「今日」というラベルとズレる）。
  const todaySummary =
    viewDate === todayStr
      ? (() => {
          const finished = [...pickResults, ...barikataResults].filter((r) => r.finished);
          const hits = finished.filter((r) => r.hit).length;
          return { total: finished.length, hits };
        })()
      : null;

  const tabs: { label: string; date: string }[] = [
    { label: "前日", date: prevDate },
    { label: "当日", date: todayStr },
    { label: "翌日", date: nextDate },
  ];

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-lg font-bold dark:text-gray-100">開催場を選択</h1>
        <RefreshTrigger compact />
      </div>
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm text-gray-400 dark:text-gray-500">{formatDateStr(viewDate)}</p>
        {lastSyncedAt && (
          <p className="text-xs text-gray-400 dark:text-gray-500">最終更新 {formatUtcAsJst(lastSyncedAt)}</p>
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
                  : "bg-white text-gray-600 border border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {todaySummary && todaySummary.total > 0 && (
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 mb-4 dark:bg-gray-800 dark:border-gray-700">
          <span className="text-xs font-semibold bg-[#0d5c3f] text-white px-2 py-0.5 rounded-full">
            今日の的中
          </span>
          <span className="text-sm font-bold tabular-nums dark:text-gray-100">
            {todaySummary.hits}/{todaySummary.total}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            ({((todaySummary.hits / todaySummary.total) * 100).toFixed(0)}%)
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500">厳選+バリカタ</span>
          <Link
            href="/history"
            className="text-xs font-semibold text-[#0d5c3f] underline ml-auto whitespace-nowrap dark:text-emerald-400"
          >
            日別履歴 →
          </Link>
        </div>
      )}

      {favoriteRacers.length > 0 && (
        <section className="bg-yellow-50 border border-yellow-200 rounded-lg shadow-sm p-3 mb-4 dark:bg-yellow-950 dark:border-yellow-900">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-yellow-500 text-white px-2 py-0.5 rounded-full">
                ★ お気に入り
              </span>
              <span className="text-xs text-yellow-800 dark:text-yellow-400">{formatDateStr(viewDate)}の出走</span>
            </div>
            <Link
              href="/favorites"
              className="text-xs font-semibold text-yellow-800 underline whitespace-nowrap dark:text-yellow-400"
            >
              一覧を見る →
            </Link>
          </div>
          {favoriteEntries.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">この日の出走はありません</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {favoriteEntries.map((f) => (
                <li key={`${f.race.id}-${f.snum}`}>
                  <Link
                    href={`/races/${f.race.id}/bets`}
                    className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
                  >
                    <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                      {f.race.start_time ?? "--:--"}
                    </span>
                    <span className="text-sm text-gray-900 flex-1 truncate dark:text-gray-100">
                      {f.race.keirinjo_name} {f.race.race_no}R
                    </span>
                    <StartingSoonBadge
                      minutes={startingSoonMinutes(f.race.start_time, viewDate, todayStr, nowHHMM)}
                    />
                    <span className="text-xs text-yellow-700 tabular-nums shrink-0 dark:text-yellow-400">
                      {f.carNum}番
                    </span>
                    <span className="text-sm font-semibold text-gray-900 truncate max-w-[8rem] dark:text-gray-100">
                      {f.racerName}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {barikataResults.length > 0 && (
        <section className="bg-rose-50 border border-rose-200 rounded-lg shadow-sm p-3 mb-4 dark:bg-rose-950 dark:border-rose-900">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold bg-rose-600 text-white px-2 py-0.5 rounded-full">
              バリカタ
            </span>
            <span className="text-xs text-rose-800 dark:text-rose-400">
              margin・ライン決着から絞った単一の並び（1点買い想定）
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {barikataByTime.map(({ pick: p, finished, hit }) => (
              <li key={p.race_id}>
                <Link
                  href={`/races/${p.race_id}/bets`}
                  className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                    {p.start_time ?? "--:--"}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate dark:text-gray-100">
                    {p.keirinjo_name} {p.race_no}R
                  </span>
                  <span className="text-sm font-mono font-bold text-rose-700 tabular-nums whitespace-nowrap dark:text-rose-400">
                    {p.combo}
                  </span>
                  <span className="text-xs font-semibold text-rose-700 tabular-nums whitespace-nowrap dark:text-rose-400">
                    差{p.margin.toFixed(1)}点
                  </span>
                  <StartingSoonBadge
                    minutes={startingSoonMinutes(p.start_time, viewDate, todayStr, nowHHMM)}
                  />
                  {finished && (
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                        hit
                          ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                          : "bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-400"
                      }`}
                    >
                      {hit ? "的中" : "不的中"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-rose-700 mt-2 leading-relaxed dark:text-rose-400">
            単一の並び的中率は検証時点で32.7%・的中時平均オッズ4.13倍（1点買い回収率約140%、母数197件）。
            必ず的中するわけではありません。
          </p>
        </section>
      )}

      {pickResults.length > 0 && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm p-3 mb-4 dark:bg-amber-950 dark:border-amber-900">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold bg-amber-500 text-white px-2 py-0.5 rounded-full">
                厳選レース
              </span>
              <span className="text-xs text-amber-800 dark:text-amber-400">
                本命の信頼度が高い上位{pickResults.length}レース
              </span>
            </div>
            <Link
              href={`/picks?date=${viewDate}`}
              className="text-xs font-semibold text-amber-800 underline whitespace-nowrap dark:text-amber-400"
            >
              タブでまとめて見る →
            </Link>
          </div>
          <ul className="flex flex-col gap-2">
            {picksByTime.map(({ pick: p, finished, hit }) => (
              <li key={p.race_id}>
                <Link
                  href={`/races/${p.race_id}/bets`}
                  className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-11 shrink-0 dark:text-gray-500">
                    {p.start_time ?? "--:--"}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate dark:text-gray-100">
                    {p.keirinjo_name} {p.race_no}R
                  </span>
                  <span className="text-xs text-gray-500 whitespace-nowrap dark:text-gray-400">
                    軸 {p.honmei_car_num}.{p.honmei_name}
                  </span>
                  <span className="text-xs font-semibold text-amber-700 tabular-nums whitespace-nowrap dark:text-amber-400">
                    差{p.margin.toFixed(1)}点
                  </span>
                  <StartingSoonBadge
                    minutes={startingSoonMinutes(p.start_time, viewDate, todayStr, nowHHMM)}
                  />
                  {finished && (
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                        hit
                          ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                          : "bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-400"
                      }`}
                    >
                      {hit ? "的中" : "不的中"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {races.length === 0 ? (
        <div className="text-center mt-8">
          <p className="text-gray-500 mb-4 dark:text-gray-400">
            {formatDateStr(viewDate)}のレースはまだ取得されていません。
            {viewDate === todayStr &&
              "毎日朝5時頃に自動取得されますが、今すぐ取得することもできます。"}
          </p>
          {viewDate <= addDaysToDateStr(todayStr, 1) && <RefreshTrigger />}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groupsByTime.map(({ jocd, groupRaces, allFinished }) => {
            const first = groupRaces[0];
            const nearestRace = pickNearestRace(groupRaces, viewDate, todayStr);
            return (
              <Link
                key={jocd}
                href={`/races/${nearestRace.id}/bets`}
                className={`flex items-center justify-between rounded-lg shadow-sm px-4 py-3 ${
                  allFinished
                    ? "bg-gray-100 active:bg-gray-200 dark:bg-gray-800/60 dark:active:bg-gray-700"
                    : "bg-white active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`font-semibold ${
                      allFinished ? "text-gray-400 dark:text-gray-500" : "text-gray-900 dark:text-gray-100"
                    }`}
                  >
                    {first.keirinjo_name}
                  </span>
                  {(() => {
                    const dayLabel = eventDayLabel(groupRaces);
                    if (!dayLabel) return null;
                    return (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          dayLabel === "最終日"
                            ? "bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400"
                            : "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                        }`}
                      >
                        {dayLabel}
                      </span>
                    );
                  })()}
                  {first.grade_kbn && (
                    <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded dark:bg-gray-700 dark:text-gray-300">
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
                            ? "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                            : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                        }`}
                      >
                        {stage}
                      </span>
                    );
                  })()}
                  {allFinished && (
                    <span className="text-[10px] font-semibold bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded dark:bg-gray-700 dark:text-gray-400">
                      終了
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <div
                    className={`text-sm ${
                      allFinished ? "text-gray-400 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    {allFinished
                      ? `全${groupRaces.length}レース終了`
                      : `${groupRaces.length}レース中 ${nearestRace.race_no}R`}
                  </div>
                  {!allFinished && nearestRace.start_time && (
                    <div className="text-xs text-gray-400 flex items-center gap-1 justify-end dark:text-gray-500">
                      <span>発走 {nearestRace.start_time}</span>
                      <StartingSoonBadge
                        minutes={startingSoonMinutes(nearestRace.start_time, viewDate, todayStr, nowHHMM)}
                      />
                    </div>
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
