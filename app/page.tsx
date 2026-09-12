import Link from "next/link";
import {
  getRacesByDate,
  getDailyPicksResults,
  getBarikataPicksResults,
  getBarikataNearMissesResults,
  getNakaanaPicksResults,
  getLastSyncedAt,
  getFavoriteRacerEntriesForDate,
  getFavoriteRacers,
  getResultsForRaces,
  getOddsForRaces,
  resolveActualCombo,
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
import { CarNumberBadge } from "../components/CarNumberBadge";
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
    <span className="text-[10px] font-bold text-[#2A0A10] bg-rose px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap">
      あと{minutes}分
    </span>
  );
}

function ResultBadge({ hit }: { hit: boolean }) {
  return hit ? (
    <span className="text-[11px] font-bold text-mint-ink bg-mint px-2 py-0.5 rounded-lg shrink-0 whitespace-nowrap">
      的中
    </span>
  ) : (
    <span className="text-[11px] font-semibold text-mist-3 bg-white/[.07] px-2 py-0.5 rounded-lg shrink-0 whitespace-nowrap">
      不的中
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
  // 開催場カードを「本日終了」でグレーアウトするための判定、および開催場カードを
  // 展開した時の「本日のレース結果」表示（着順・払戻）に使う（どちらもpredictRaceを
  // 使わない軽いクエリなので、ここで全レース分まとめて取っても表示は重くならない）。
  const raceIds = races.map((r) => r.id);
  const resultsByRaceId = await getResultsForRaces(raceIds);
  const oddsByRaceId = await getOddsForRaces(raceIds);

  // 「本日の厳選レース」：結果未確定（前日以前は対象外）の日だけ、
  // scripts/compute-picks.tsが事前計算したdaily_picksからその日の本命marginが
  // 大きい順に上位10件を表示する。
  const showPicks = viewDate === todayStr || viewDate === nextDate;
  const pickResults = showPicks ? await getDailyPicksResults(viewDate) : [];
  // ホーム画面のプレビュー一覧は発走時刻順に並べ替える（時刻がバラバラなので
  // 時系列で見えた方が分かりやすい。タブ切り替え版は/picksで発走順に見られる）。
  const picksByTime = [...pickResults].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 「本日のバリカタ」：margin>=8かつ予想1-2-3位が同ラインのレース。
  // 厳選（フォーメーション買い）とは別枠で、単一の並び（1点）を想定した高的中率
  // 狙いのピック。scripts/compute-picks.tsのコメント参照。
  const barikataResults = showPicks ? await getBarikataPicksResults(viewDate) : [];
  const barikataByTime = [...barikataResults].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 「バリカタ候補漏れ」：marginは同じ基準を満たすが同ラインでなかったレース
  // （参考表示。db/schema.sqlのbarikata_near_missesコメント参照——同marginでも
  // 単一の並び的中率はバリカタ本体よりかなり低い）。
  const barikataNearMisses = showPicks ? await getBarikataNearMissesResults(viewDate) : [];
  const nearMissesByTime = [...barikataNearMisses].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 「中穴候補」：margin8〜10・非同ライン向けの参考買い目（lib/scoring.tsの
  // generateNakaanaCandidate参照）。母数がまだ369件・5.5ヶ月分の検証しかなく、
  // 厳選・バリカタと同列の推奨扱いはしないため、的中サマリー(todaySummary)にも
  // 含めない参考表示専用。
  const nakaanaPicks = showPicks ? await getNakaanaPicksResults(viewDate) : [];
  const nakaanaByTime = [...nakaanaPicks].sort((a, b) =>
    (a.pick.start_time ?? "").localeCompare(b.pick.start_time ?? "")
  );

  // 開催場カードを展開した時の的中/不的中バッジ用に、レースIDごとの
  // 「厳選/バリカタ/中穴候補」の的中結果をまとめておく（1レースが複数の
  // 仕組みに同時に該当することもある、例: 厳選かつバリカタ）。
  const pickHitsByRaceId = new Map<number, { label: string; hit: boolean }[]>();
  const addHits = (label: string, results: { pick: { race_id: number }; finished: boolean; hit: boolean | null }[]) => {
    for (const r of results) {
      if (!r.finished) continue;
      const arr = pickHitsByRaceId.get(r.pick.race_id) ?? [];
      arr.push({ label, hit: r.hit ?? false });
      pickHitsByRaceId.set(r.pick.race_id, arr);
    }
  };
  addHits("厳選", pickResults);
  addHits("バリカタ", barikataResults);
  addHits("中穴", nakaanaPicks);

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
    <main className="bg-ink-0 flex-1">
      <div className="max-w-lg mx-auto w-full px-4 py-4">
        <div className="flex items-center justify-between gap-3 pb-3 mb-4 border-b border-white/[.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-mint to-[#127A57] flex items-center justify-center text-[13px] font-black text-mint-ink">
              K
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-base font-bold text-mist-0">競輪予想</span>
              <span className="text-[10px] font-mono text-mist-4">
                {formatDateStr(viewDate)}
                {lastSyncedAt && ` ・ ${formatUtcAsJst(lastSyncedAt)} 更新`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <RefreshTrigger compact />
            <Link
              href="/history"
              className="w-8 h-8 rounded-[11px] bg-white/5 flex items-center justify-center text-[11px] text-mist-2"
            >
              履歴
            </Link>
            <Link
              href="/settings"
              className="w-8 h-8 rounded-[11px] bg-white/5 flex items-center justify-center text-[11px] text-mist-2"
            >
              設定
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 p-1 bg-white/[.04] rounded-[14px] mb-4">
          {tabs.map((tab) => {
            const active = tab.date === viewDate;
            const href = tab.date === todayStr ? "/" : `/?date=${tab.date}`;
            return (
              <Link
                key={tab.label}
                href={href}
                className={`text-center py-2 rounded-[11px] text-sm font-bold ${
                  active ? "bg-mint text-mint-ink" : "text-mist-3"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>

        {todaySummary && todaySummary.total > 0 && (
          <div className="flex items-center gap-4 rounded-[20px] p-4 mb-4 border border-mint/[.18] bg-gradient-to-br from-mint/[.13] to-mint/[.02]">
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-[11px] tracking-wide text-mint-strong">今日の的中（厳選＋バリカタ）</span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[34px] font-medium text-mist-0 leading-none">
                  {todaySummary.hits}
                  <span className="text-lg text-mist-4">/{todaySummary.total}</span>
                </span>
                <span className="text-[15px] font-bold text-mint">
                  {((todaySummary.hits / todaySummary.total) * 100).toFixed(0)}%
                </span>
              </div>
              <div className="h-[5px] rounded-full bg-white/[.08] overflow-hidden mt-2">
                <div
                  className="h-full bg-mint"
                  style={{ width: `${(todaySummary.hits / todaySummary.total) * 100}%` }}
                />
              </div>
            </div>
            <Link href="/history" className="text-xs text-mint-strong whitespace-nowrap shrink-0">
              日別 →
            </Link>
          </div>
        )}

        {favoriteRacers.length > 0 && (
          <section className="flex flex-col gap-2 mb-4">
            <div className="flex items-center gap-2 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gold" />
              <span className="text-sm font-bold text-mist-0">お気に入り選手</span>
              <span className="text-[11px] text-mist-4 flex-1">{formatDateStr(viewDate)}の出走</span>
              <Link href="/favorites" className="text-[11px] font-semibold text-gold whitespace-nowrap">
                一覧を見る →
              </Link>
            </div>
            {favoriteEntries.length === 0 ? (
              <p className="text-xs text-mist-4 px-1">この日の出走はありません</p>
            ) : (
              favoriteEntries.map((f) => (
                <Link
                  key={`${f.race.id}-${f.snum}`}
                  href={`/races/${f.race.id}`}
                  className="flex items-center gap-3 rounded-[18px] px-3.5 py-3 border border-gold/[.18] bg-ink-3"
                >
                  <span className="text-[13px] text-gold">★</span>
                  <span className="font-mono text-xs text-mist-4 w-11 shrink-0">
                    {f.race.start_time ?? "--:--"}
                  </span>
                  <span className="text-sm font-bold text-mist-0 flex-1 truncate">
                    {f.race.keirinjo_name} {f.race.race_no}R
                  </span>
                  <span className="text-xs text-mist-2 shrink-0">{f.carNum}番</span>
                  <span className="text-sm font-semibold text-mist-1 truncate max-w-[6.5rem]">
                    {f.racerName}
                  </span>
                  <StartingSoonBadge
                    minutes={startingSoonMinutes(f.race.start_time, viewDate, todayStr, nowHHMM)}
                  />
                </Link>
              ))
            )}
          </section>
        )}

        {barikataResults.length > 0 && (
          <section className="flex flex-col gap-2.5 mb-4">
            <div className="flex items-center gap-2 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-rose" />
              <span className="text-sm font-bold text-mist-0">バリカタ</span>
              <span className="text-[11px] text-mist-4 flex-1">単一の並び・1点買い想定</span>
              <span className="font-mono text-[11px] text-rose-soft">{barikataResults.length} races</span>
            </div>
            {barikataByTime.map(({ pick: p, finished, hit }) => (
              <Link
                key={p.race_id}
                href={`/races/${p.race_id}`}
                className="flex flex-col gap-2.5 rounded-[18px] p-3.5 border border-rose/[.16] bg-ink-3"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-xs text-mist-4">{p.start_time ?? "--:--"}</span>
                  <span className="text-[15px] font-bold text-mist-0">{p.keirinjo_name}</span>
                  <span className="font-mono text-[13px] text-mist-2">{p.race_no}R</span>
                  <span className="flex-1" />
                  {finished ? (
                    <ResultBadge hit={hit ?? false} />
                  ) : (
                    <StartingSoonBadge minutes={startingSoonMinutes(p.start_time, viewDate, todayStr, nowHHMM)} />
                  )}
                </div>
                <div className="flex items-end justify-between">
                  <span className="font-mono text-[28px] font-medium tracking-[.02em] text-rose-soft leading-none">
                    {p.combo}
                  </span>
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-mist-4">スコア差</span>
                    <span className="font-mono text-[15px] text-mist-0">{p.margin.toFixed(1)}</span>
                  </div>
                </div>
              </Link>
            ))}
            <p className="text-[11px] leading-relaxed text-mist-4 px-1">
              検証時点の的中率32.7%・平均オッズ4.13倍（1点買い回収率約140%／母数197件）。必ず的中するものではありません。
            </p>
          </section>
        )}

        {barikataNearMisses.length > 0 && (
          <details className="flex flex-col mb-4 rounded-[18px] bg-ink-2 border border-white/[.06] overflow-hidden group">
            <summary className="px-3.5 py-3.5 flex items-center gap-2 cursor-pointer select-none marker:content-none [&::-webkit-details-marker]:hidden">
              <span className="text-[13px] font-bold text-mist-2 flex-1">
                参考：バリカタ候補漏れ
                <span className="font-mono text-mist-4 font-normal"> {barikataNearMisses.length}</span>
              </span>
              <span className="text-[11px] text-mist-4 group-open:hidden">開く ⌄</span>
              <span className="text-[11px] text-mist-4 hidden group-open:inline">閉じる ⌃</span>
            </summary>
            <div className="px-3.5 pb-3.5 flex flex-col gap-px">
              {nearMissesByTime.map(({ pick: n, finished, hit }) => (
                <Link
                  key={n.race_id}
                  href={`/races/${n.race_id}`}
                  className="flex items-center gap-2.5 py-2.5 border-t border-white/[.05]"
                >
                  <span className="font-mono text-[11px] text-mist-5 w-11 shrink-0">
                    {n.start_time ?? "--:--"}
                  </span>
                  <span className="text-[13px] text-mist-2 flex-1 truncate">
                    {n.keirinjo_name} {n.race_no}R
                  </span>
                  <span className="font-mono text-[13px] text-mist-3">{n.combo}</span>
                  <span className="font-mono text-[11px] text-mist-5">{n.margin.toFixed(1)}</span>
                  {finished && <ResultBadge hit={hit ?? false} />}
                </Link>
              ))}
              <p className="text-[11px] leading-relaxed text-mist-5 pt-2">
                3着候補が他ラインのため、単一の並びとしての的中率は大きく下がります（同margin帯で同ライン決着の約1/3）。
              </p>
            </div>
          </details>
        )}

        {nakaanaPicks.length > 0 && (
          <details className="flex flex-col mb-4 rounded-[18px] bg-ink-2 border border-white/[.06] overflow-hidden group">
            <summary className="px-3.5 py-3.5 flex items-center gap-2 cursor-pointer select-none marker:content-none [&::-webkit-details-marker]:hidden">
              <span className="text-[13px] font-bold text-mist-2 flex-1">
                参考：中穴候補
                <span className="font-mono text-mist-4 font-normal"> {nakaanaPicks.length}</span>
              </span>
              <span className="text-[11px] text-mist-4 group-open:hidden">開く ⌄</span>
              <span className="text-[11px] text-mist-4 hidden group-open:inline">閉じる ⌃</span>
            </summary>
            <div className="px-3.5 pb-3.5 flex flex-col gap-px">
              {nakaanaByTime.map(({ pick: n, finished, hit }) => (
                <Link
                  key={n.race_id}
                  href={`/races/${n.race_id}`}
                  className="flex items-center gap-2.5 py-2.5 border-t border-white/[.05]"
                >
                  <span className="font-mono text-[11px] text-mist-5 w-11 shrink-0">
                    {n.start_time ?? "--:--"}
                  </span>
                  <span className="text-[13px] text-mist-2 flex-1 truncate">
                    {n.keirinjo_name} {n.race_no}R
                  </span>
                  <span className="text-[11px] text-mist-4 whitespace-nowrap">
                    軸{n.honmei_car_num}-対抗{n.taikou_car_num}
                  </span>
                  <span className="font-mono text-[11px] text-mist-5">{n.margin.toFixed(1)}</span>
                  {finished && <ResultBadge hit={hit ?? false} />}
                </Link>
              ))}
              <p className="text-[11px] leading-relaxed text-mist-5 pt-2">
                margin8〜10・予想1-2-3位が他ライン混在のレース向けの試験的な買い目（◎→対抗固定→3-5位のいずれか、3点）。
                過去検証（369件・約5.5ヶ月）では回収率190%台と有望でしたが、母数がまだ薄く「厳選」「バリカタ」ほどの
                信頼度はありません。実績を見ながら判断してください。
              </p>
            </div>
          </details>
        )}

        {pickResults.length > 0 && (
          <section className="flex flex-col gap-2.5 mb-4">
            <div className="flex items-center gap-2 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gold" />
              <span className="text-sm font-bold text-mist-0">厳選レース</span>
              <span className="text-[11px] text-mist-4 flex-1">本命の信頼度が高い{pickResults.length}本</span>
              <Link href={`/picks?date=${viewDate}`} className="text-[11px] font-semibold text-gold whitespace-nowrap">
                すべて →
              </Link>
            </div>
            <div className="rounded-[18px] bg-ink-3 border border-white/[.06] overflow-hidden">
              {picksByTime.map(({ pick: p, finished, hit }) => (
                <Link
                  key={p.race_id}
                  href={`/races/${p.race_id}`}
                  className="flex items-center gap-2.5 px-3.5 py-3.5 border-t border-white/[.05] first:border-t-0"
                >
                  <span className="font-mono text-xs text-mist-4 w-11 shrink-0">{p.start_time ?? "--:--"}</span>
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[15px] font-bold text-mist-0">{p.keirinjo_name}</span>
                      <span className="font-mono text-xs text-mist-2">{p.race_no}R</span>
                    </div>
                    <span className="text-[11px] text-mist-3 truncate">
                      軸 {p.honmei_car_num}.{p.honmei_name}
                    </span>
                  </div>
                  <span className="font-mono text-[13px] text-gold">{p.margin.toFixed(1)}</span>
                  {finished ? (
                    <ResultBadge hit={hit ?? false} />
                  ) : (
                    <StartingSoonBadge minutes={startingSoonMinutes(p.start_time, viewDate, todayStr, nowHHMM)} />
                  )}
                </Link>
              ))}
            </div>
          </section>
        )}

        {races.length === 0 ? (
          <div className="text-center mt-8">
            <p className="text-mist-3 mb-4">
              {formatDateStr(viewDate)}のレースはまだ取得されていません。
              {viewDate === todayStr &&
                "毎日朝5時頃に自動取得されますが、今すぐ取得することもできます。"}
            </p>
            {viewDate <= addDaysToDateStr(todayStr, 1) && <RefreshTrigger />}
          </div>
        ) : (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue" />
              <span className="text-sm font-bold text-mist-0">開催場</span>
              <span className="text-[11px] text-mist-4">{groupsByTime.length}場開催中</span>
            </div>
            {groupsByTime.map(({ jocd, groupRaces, allFinished }) => {
              const first = groupRaces[0];
              const nearestRace = pickNearestRace(groupRaces, viewDate, todayStr);
              const dayLabel = eventDayLabel(groupRaces);
              const stage = raceStage(nearestRace.syumoku);
              const raceRows = [...groupRaces]
                .sort((a, b) => a.race_no - b.race_no)
                .map((race) => {
                  const results = resultsByRaceId.get(race.id) ?? [];
                  const odds = oddsByRaceId.get(race.id) ?? [];
                  const top3 = results
                    .filter((r) => r.finish_pos != null && r.finish_pos <= 3)
                    .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
                  const actualCombo = top3.length === 3 ? resolveActualCombo(results, odds) : null;
                  const hitOdds =
                    actualCombo != null
                      ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo) ?? null)
                      : null;
                  const hits = pickHitsByRaceId.get(race.id) ?? [];
                  return { race, top3, payoutOdds: hitOdds?.odds_value ?? null, ninki: hitOdds?.ninki ?? null, hits };
                });

              return (
                <details
                  key={jocd}
                  className={`rounded-[18px] border border-white/[.06] overflow-hidden group ${
                    allFinished ? "bg-ink-2 opacity-60" : "bg-ink-3"
                  }`}
                >
                  <summary className="flex items-center gap-3 p-3.5 cursor-pointer select-none marker:content-none [&::-webkit-details-marker]:hidden">
                    <span className="text-lg font-black text-mist-0 shrink-0">{first.keirinjo_name}</span>
                    <div className="flex gap-1.5 flex-1 flex-wrap">
                      {dayLabel && (
                        <span
                          className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                            dayLabel === "最終日" ? "text-rose bg-rose/[.14]" : "text-blue bg-blue/[.14]"
                          }`}
                        >
                          {dayLabel}
                        </span>
                      )}
                      {first.grade_kbn && (
                        <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-gold-ink bg-gold">
                          {first.grade_kbn}
                        </span>
                      )}
                      {stage !== "不明" && (
                        <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-mint bg-mint/[.12]">
                          {stage}
                        </span>
                      )}
                      {allFinished && (
                        <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-mist-4 bg-white/[.07]">
                          終了
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <span className="font-mono text-[13px] text-mist-0">
                        {allFinished ? `全${groupRaces.length}R` : `${nearestRace.race_no}R / ${groupRaces.length}`}
                      </span>
                      {!allFinished && nearestRace.start_time && (
                        <span className="text-[10px] text-mist-4 flex items-center gap-1">
                          発走 {nearestRace.start_time}
                          <StartingSoonBadge
                            minutes={startingSoonMinutes(nearestRace.start_time, viewDate, todayStr, nowHHMM)}
                          />
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-mist-4 group-open:hidden shrink-0">開く ⌄</span>
                    <span className="text-[11px] text-mist-4 hidden group-open:inline shrink-0">閉じる ⌃</span>
                  </summary>
                  <div className="px-3.5 pb-3.5 flex flex-col gap-px">
                    <Link
                      href={`/races/${nearestRace.id}`}
                      className="flex items-center justify-between py-2.5 border-t border-white/[.05] text-mint-strong"
                    >
                      <span className="text-xs font-semibold">
                        {allFinished ? "予想・買い目を見る" : `次走 ${nearestRace.race_no}Rの予想を見る`}
                      </span>
                      <span className="text-xs">→</span>
                    </Link>
                    {raceRows.map(({ race, top3, payoutOdds, ninki, hits }) => (
                      <Link
                        key={race.id}
                        href={`/races/${race.id}`}
                        className="flex items-center gap-2.5 py-2.5 border-t border-white/[.05]"
                      >
                        <span className="font-mono text-[11px] text-mist-4 w-9 shrink-0">{race.race_no}R</span>
                        <div className="flex-1 flex items-center gap-1 min-w-0">
                          {top3.length === 3 ? (
                            top3.map((r) => <CarNumberBadge key={r.car_num} carNum={r.car_num} size="sm" />)
                          ) : (
                            <span className="text-[11px] text-mist-5 truncate">
                              {race.start_time ? `発走 ${race.start_time}` : "結果未定"}
                            </span>
                          )}
                        </div>
                        {payoutOdds != null && (
                          <div className="flex flex-col items-end shrink-0">
                            <span className="font-mono text-[12px] text-mist-2">{(100 * payoutOdds).toFixed(0)}円</span>
                            {ninki != null && <span className="text-[10px] text-mist-5">{ninki}番人気</span>}
                          </div>
                        )}
                        {hits.length > 0 && (
                          <div className="flex gap-1 shrink-0">
                            {hits.map((h, i) => (
                              <span
                                key={i}
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                  h.hit ? "text-mint-ink bg-mint" : "text-mist-4 bg-white/[.07]"
                                }`}
                              >
                                {h.label}
                                {h.hit ? "○" : "×"}
                              </span>
                            ))}
                          </div>
                        )}
                      </Link>
                    ))}
                  </div>
                </details>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
