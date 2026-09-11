import Link from "next/link";
import { notFound } from "next/navigation";
import { predictRace } from "../../../lib/predict";
import {
  getPredictionsForRace,
  getRacesForEvent,
  getRacesByDate,
  getResultsForRaces,
  getResultsForRace,
  getOddsForRace,
  resolveActualCombo,
  isRaceFinished,
  getSoloWinRate,
  getScenarioStats,
  getScenarioRankStats,
  getVenueKimariteRank,
  getLinePartnershipHistory,
} from "../../../lib/repository";
import { recordPredictionAction } from "../../../lib/actions";
import {
  isSoloInRace,
  CLASS_RANK_SCORES,
  SOLO_MIN_RACES,
  STANDING_COUNT_HIGH_THRESHOLD,
  formatFormationNotation,
  pickNearestRace,
} from "../../../lib/scoring";
import { todayJstStr, formatDateStr } from "../../../lib/date";
import { CarNumberBadge } from "../../../components/CarNumberBadge";
import { MarkBadge } from "../../../components/MarkBadge";
import { RecentFormBadge } from "../../../components/RecentFormBadge";
import { ScoreBar } from "../../../components/ScoreBar";
import { RaceSwitcher } from "../../../components/RaceSwitcher";
import { VenueSwitcher, type VenueOption } from "../../../components/VenueSwitcher";
import { buildWinticketResultUrl } from "../../../lib/winticket";

/** 配列から2要素の組み合わせを全て作る（3人ラインなら3ペア）。 */
function pairCombinations<T>(arr: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  return out;
}

function formatDate(kaisaiDate: string): string {
  const y = kaisaiDate.slice(0, 4);
  const m = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  return `${y}/${m}/${d}`;
}

function ResultBadge({ hit }: { hit: boolean }) {
  return hit ? (
    <span className="text-xs font-bold text-mint-ink bg-mint px-2 py-0.5 rounded-full shrink-0">的中</span>
  ) : (
    <span className="text-xs font-semibold text-mist-3 bg-white/[.07] px-2 py-0.5 rounded-full shrink-0">
      不的中
    </span>
  );
}

const KIMARITE_BAR_COLORS: Record<string, string> = {
  逃げ: "#5B9CFF",
  捲り: "#F5B544",
  差し: "#FF5D73",
};

export default async function RaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const raceId = Number(id);
  const prediction = await predictRace(raceId);
  if (!prediction) notFound();

  const { race, bankInfo, venueKimarite, scored, scenarios, boxSuggestion, winSuggestion } = prediction;
  const top4 = scored.slice(0, 4);
  const alreadyRecorded = (await getPredictionsForRace(raceId)).length > 0;
  const recordPredictionForRace = recordPredictionAction.bind(null, raceId);
  const eventRaces = await getRacesForEvent(race.kaisai_date, race.jocd);
  const eventResults = await getResultsForRaces(eventRaces.map((r) => r.id));
  const finishedRaceIds = new Set(
    eventRaces.filter((r) => isRaceFinished(eventResults.get(r.id) ?? [])).map((r) => r.id)
  );
  const scenarioStats = await getScenarioStats();
  // 本命以外のシナリオが実際に当たるかどうかは、シナリオ全体の累計実績（本命の
  // 母数が一番大きく常に最強に見える）ではなく、そのレースでの有力度＝likelyRank
  // 別の実績で見せる（scripts/diagnose-scenario-condition.tsで検証）。
  const scenarioRankStats = await getScenarioRankStats();
  const kimariteRank = await getVenueKimariteRank(race.jocd);

  // 他の開催場へトップに戻らず移動できるドロップダウン用。同日の全レースを
  // 開催場ごとにまとめ、各開催場の「今行くならこのレース」1件を選択肢にする
  // （ホーム画面の開催場カードと同じpickNearestRaceのロジック）。
  const todayStr = todayJstStr();
  const racesOnSameDate = await getRacesByDate(race.kaisai_date);
  const venueGroups = new Map<string, typeof racesOnSameDate>();
  for (const r of racesOnSameDate) {
    if (!venueGroups.has(r.jocd)) venueGroups.set(r.jocd, []);
    venueGroups.get(r.jocd)!.push(r);
  }
  const venueOptions: VenueOption[] = [...venueGroups.entries()]
    .map(([jocd, groupRaces]) => ({
      jocd,
      keirinjoName: groupRaces[0].keirinjo_name,
      startTime: groupRaces[0].start_time,
      targetRaceId: pickNearestRace(groupRaces, race.kaisai_date, todayStr).id,
    }))
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
    .map(({ jocd, keirinjoName, targetRaceId }) => ({ jocd, keirinjoName, targetRaceId }));

  // 既に採用済みのスコア加点（単騎個人成績・ライン内格差）は現状totalScoreに
  // 混ざったまま内訳が見えないため、実数値を表示用に別途計算する
  // （lib/scoring.tsの計算ロジック自体は変更しない、表示のみの追加）。
  const allEntries = scored.map((s) => s.entry);
  const soloWinRates = await Promise.all(
    scored.map((s) =>
      isSoloInRace(s.entry, allEntries) ? getSoloWinRate(s.entry.snum, race.kaisai_date) : Promise.resolve(null)
    )
  );

  // レースが終わっていれば実際の着順・的中判定を表示する。actualComboの解決は
  // lib/accuracy.tsのcomputeRaceSummary・scripts/backtest.tsと同じロジック。
  const [results, odds] = await Promise.all([getResultsForRace(raceId), getOddsForRace(raceId)]);
  const nameByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.name]));
  const snumByCarNum = new Map(scored.map((s) => [s.entry.car_num, s.entry.snum]));

  // ライン構成：先頭→番手→3番手の順に並べる。scoredは既にtotalScore降順のため、
  // Mapの挿入順を使うだけで「◎を含むラインが先頭に来る」表示順になる。
  const LINE_POSITION_ORDER: Record<string, number> = { 先頭: 0, 番手: 1, "3番手": 2 };
  const lineGroups = new Map<number, typeof scored>();
  const soloEntries: typeof scored = [];
  for (const s of scored) {
    if (s.entry.line_group == null) {
      soloEntries.push(s);
      continue;
    }
    const arr = lineGroups.get(s.entry.line_group) ?? [];
    arr.push(s);
    lineGroups.set(s.entry.line_group, arr);
  }
  const lines = [...lineGroups.values()].map((members) =>
    [...members].sort(
      (a, b) =>
        (LINE_POSITION_ORDER[a.entry.line_position ?? ""] ?? 9) -
        (LINE_POSITION_ORDER[b.entry.line_position ?? ""] ?? 9)
    )
  );
  const linePartnerships = await Promise.all(
    lines.map((members) =>
      members.length >= 2
        ? getLinePartnershipHistory(members.map((m) => m.entry.snum), race.kaisai_date)
        : Promise.resolve([])
    )
  );
  const finishOrder = results
    .filter((r) => r.finish_pos != null)
    .sort((a, b) => (a.finish_pos ?? 0) - (b.finish_pos ?? 0));
  const top3Results = finishOrder.filter((r) => (r.finish_pos ?? 0) <= 3);
  const raceFinished = isRaceFinished(results);
  const actualCombo = raceFinished ? resolveActualCombo(results, odds) : null;
  const sanrentanHitOdds =
    actualCombo != null
      ? (odds.find((o) => o.bet_type === "3連単" && o.combination === actualCombo)?.odds_value ?? null)
      : null;
  const winticketUrl = buildWinticketResultUrl(race);
  const actualTop3Set = new Set(top3Results.map((r) => r.car_num));
  const winnerCarNum = finishOrder.find((r) => r.finish_pos === 1)?.car_num ?? null;
  const sortedActualTop3 =
    actualTop3Set.size === 3 ? [...actualTop3Set].sort((a, b) => a - b).join("-") : null;

  // venues/[jocd]と同じ解決ロジック（自場実績→同周長グループ実績→bank_info静的値）。
  const kimariteRates =
    venueKimarite ??
    (bankInfo?.nige_pct != null && bankInfo?.makuri_pct != null && bankInfo?.sashi_pct != null
      ? { nige_pct: bankInfo.nige_pct, makuri_pct: bankInfo.makuri_pct, sashi_pct: bankInfo.sashi_pct }
      : null);
  const kimariteSourceLabel = venueKimarite
    ? `実績${venueKimarite.races}走`
    : kimariteRates
      ? "参考値(KEIRIN.JP掲載)"
      : null;

  return (
    <main className="bg-ink-0 flex-1">
      <div className="max-w-lg mx-auto w-full px-4 py-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <Link href="/" className="w-8 h-8 rounded-[11px] bg-white/5 flex items-center justify-center text-[15px] text-mist-0 shrink-0">
            ‹
          </Link>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-base font-bold text-mist-0 leading-tight truncate">
              {race.keirinjo_name} {race.race_no}R
            </span>
            <span className="text-[11px] font-mono text-mist-4">
              {formatDate(race.kaisai_date)} ・ {race.syumoku ?? ""} {race.grade_kbn ?? ""}
              {race.start_time ? ` 発走${race.start_time}` : ""}
            </span>
          </div>
          <VenueSwitcher venues={venueOptions} currentJocd={race.jocd} />
        </div>

        <RaceSwitcher races={eventRaces} currentRaceId={race.id} finishedRaceIds={finishedRaceIds} />

        <div className="flex items-center justify-between mt-3 mb-4 gap-2">
          {alreadyRecorded ? (
            <p className="text-xs text-mist-4">
              この予想は記録済みです（
              <Link href="/history" className="underline text-mint-strong">
                履歴を見る
              </Link>
              ）
            </p>
          ) : (
            <form action={recordPredictionForRace}>
              <button
                type="submit"
                className="text-xs font-semibold text-mint border border-mint/30 rounded-lg px-3 py-1.5 active:opacity-70"
              >
                この予想を記録する
              </button>
            </form>
          )}
          {winticketUrl && (
            <a
              href={winticketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-mint whitespace-nowrap shrink-0 rounded-lg px-3 py-1.5 bg-mint/[.12]"
            >
              WINTICKETで{raceFinished ? "結果・映像" : "確認"} →
            </a>
          )}
        </div>

        {kimariteRates && (
          <section className="rounded-[20px] bg-ink-3 border border-white/[.06] p-4 flex flex-col gap-3 mb-4">
            <div className="flex items-center">
              <span className="text-[13px] font-bold text-mist-0 flex-1">このバンクの決まり手</span>
              {kimariteSourceLabel && (
                <span className="font-mono text-[11px] text-mist-4">{kimariteSourceLabel}</span>
              )}
            </div>
            <div className="flex h-2 rounded-[5px] overflow-hidden gap-0.5">
              <div style={{ width: `${kimariteRates.nige_pct}%`, background: KIMARITE_BAR_COLORS.逃げ }} />
              <div style={{ width: `${kimariteRates.makuri_pct}%`, background: KIMARITE_BAR_COLORS.捲り }} />
              <div style={{ width: `${kimariteRates.sashi_pct}%`, background: KIMARITE_BAR_COLORS.差し }} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["逃げ", kimariteRates.nige_pct, kimariteRank?.nigeRank],
                  ["捲り", kimariteRates.makuri_pct, kimariteRank?.makuriRank],
                  ["差し", kimariteRates.sashi_pct, kimariteRank?.sashiRank],
                ] as const
              ).map(([label, pct, rank]) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: KIMARITE_BAR_COLORS[label] }} />
                    <span className="text-xs text-mist-2">{label}</span>
                  </div>
                  <span className="font-mono text-[17px] text-mist-0">{pct.toFixed(0)}%</span>
                  {rank != null && kimariteRank && (
                    <span className="text-[10px] text-mist-5">
                      全{kimariteRank.totalVenues}場中{rank}位
                    </span>
                  )}
                </div>
              ))}
            </div>
            {bankInfo?.feature_text && (
              <p className="text-[11px] text-mist-4">{bankInfo.feature_text}</p>
            )}
          </section>
        )}

        <div className="grid grid-cols-2 gap-2 mb-4">
          {top4.map((s) => (
            <Link
              key={s.entry.entry_id}
              href={`/racers/${s.entry.snum}`}
              className="flex items-center gap-2 p-2.5 rounded-2xl bg-ink-3 border border-white/[.06]"
            >
              <MarkBadge mark={s.mark} />
              <CarNumberBadge carNum={s.entry.car_num} size="sm" />
              <span className="text-[13px] font-bold text-mist-0 truncate flex-1">{s.entry.name}</span>
              <RecentFormBadge avgFinish={s.recentFormAvg} />
            </Link>
          ))}
        </div>

        {lines.length > 0 && (
          <section className="rounded-[20px] bg-ink-3 border border-white/[.06] p-4 flex flex-col gap-3 mb-4">
            <span className="text-[13px] font-bold text-mist-0">ライン構成</span>
            {lines.map((members, lineIdx) => {
              const nameBySnum = new Map(members.map((s) => [s.entry.snum, s.entry.name]));
              const occurrences = linePartnerships[lineIdx];
              return (
                <div key={members[0].entry.line_group} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    {members.map((s) => (
                      <CarNumberBadge key={s.entry.car_num} carNum={s.entry.car_num} size="sm" />
                    ))}
                    <span className="text-xs text-mist-3 ml-1 truncate">
                      {members.map((s) => s.entry.name).join("・")}
                    </span>
                  </div>
                  {pairCombinations(members.map((s) => s.entry.snum)).map(([snumA, snumB]) => {
                    const relevant = occurrences.filter(
                      (occ) =>
                        occ.members.some((m) => m.snum === snumA) &&
                        occ.members.some((m) => m.snum === snumB)
                    );
                    if (relevant.length === 0) return null;
                    let winsA = 0;
                    let winsB = 0;
                    for (const occ of relevant) {
                      const a = occ.members.find((m) => m.snum === snumA);
                      const b = occ.members.find((m) => m.snum === snumB);
                      if (a?.finishPos == null || b?.finishPos == null) continue;
                      if (a.finishPos < b.finishPos) winsA++;
                      else if (b.finishPos < a.finishPos) winsB++;
                    }
                    const nameA = nameBySnum.get(snumA) ?? snumA;
                    const nameB = nameBySnum.get(snumB) ?? snumB;
                    return (
                      <details key={`${snumA}-${snumB}`} className="group">
                        <summary className="text-[11px] text-mist-5 cursor-pointer select-none pl-1.5 border-l-2 border-white/[.08] marker:content-none [&::-webkit-details-marker]:hidden">
                          <span className="inline-block w-3 text-center group-open:hidden">▶</span>
                          <span className="hidden w-3 text-center group-open:inline-block">▼</span>
                          {" "}対戦成績 {nameA} {winsA}-{winsB} {nameB}（同ライン{relevant.length}回）
                        </summary>
                        <ul className="flex flex-col gap-0.5 pl-1.5 border-l-2 border-white/[.08] ml-1.5 mt-0.5">
                          {relevant.slice(0, 8).map((occ) => {
                            const url = buildWinticketResultUrl({ jocd: occ.jocd, encp: occ.encp });
                            const memberSummary = [...occ.members]
                              .sort((a, b) => (a.finishPos ?? 99) - (b.finishPos ?? 99))
                              .map((m) => `${nameBySnum.get(m.snum) ?? m.snum}${m.finishPos != null ? m.finishPos + "着" : ""}`)
                              .join(" ");
                            return (
                              <li key={occ.raceId} className="text-[11px] text-mist-5">
                                {formatDateStr(occ.kaisaiDate)} {occ.keirinjoName}
                                {occ.raceNo}R 同ライン: {memberSummary}
                                {url && (
                                  <>
                                    {" "}
                                    <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-mint-strong">
                                      WINTICKET
                                    </a>
                                  </>
                                )}
                              </li>
                            );
                          })}
                          {relevant.length > 8 && (
                            <li className="text-[11px] text-mist-5">ほか{relevant.length - 8}件（直近8件のみ表示）</li>
                          )}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              );
            })}
            {soloEntries.length > 0 && (
              <div className="flex items-center gap-1.5 pt-1 border-t border-white/[.06]">
                <span className="text-xs text-mist-4 shrink-0">単騎</span>
                {soloEntries.map((s) => (
                  <CarNumberBadge key={s.entry.car_num} carNum={s.entry.car_num} size="sm" />
                ))}
              </div>
            )}
          </section>
        )}

        <details className="rounded-[20px] bg-ink-2 border border-white/[.06] overflow-hidden mb-4 group">
          <summary className="px-4 py-3.5 flex items-center gap-2 cursor-pointer select-none marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="text-[13px] font-bold text-mist-2 flex-1">全{scored.length}名のスコア内訳</span>
            <span className="text-[11px] text-mist-4 group-open:hidden">開く ⌄</span>
            <span className="text-[11px] text-mist-4 hidden group-open:inline">閉じる ⌃</span>
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-3">
            {scored.map((s, i) => {
              const soloWinRate = soloWinRates[i];
              const senko = scored.find(
                (x) => x.entry.line_group === s.entry.line_group && x.entry.line_position === "先頭"
              );
              const myClassScore = s.entry.class_rank ? CLASS_RANK_SCORES[s.entry.class_rank] : undefined;
              const senkoClassScore = senko?.entry.class_rank ? CLASS_RANK_SCORES[senko.entry.class_rank] : undefined;
              const lineRankLabel =
                (s.entry.line_position === "番手" || s.entry.line_position === "3番手") &&
                senko &&
                senko.entry.snum !== s.entry.snum &&
                myClassScore != null &&
                senkoClassScore != null
                  ? myClassScore > senkoClassScore
                    ? "格上"
                    : myClassScore < senkoClassScore
                      ? "格下"
                      : "同格"
                  : null;
              const isBantesu = s.entry.line_position === "番手" || s.entry.line_position === "3番手";
              const highStanding =
                isBantesu &&
                s.entry.standing_count != null &&
                s.entry.standing_count >= STANDING_COUNT_HIGH_THRESHOLD;
              return (
                <div key={s.entry.entry_id} className="pt-3 border-t border-white/[.06] first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <MarkBadge mark={s.mark} />
                    <CarNumberBadge carNum={s.entry.car_num} />
                    <Link href={`/racers/${s.entry.snum}`} className="font-bold flex-1 truncate text-mist-0 text-sm">
                      {s.entry.name}
                    </Link>
                    <RecentFormBadge avgFinish={s.recentFormAvg} />
                    <span className="font-mono text-lg font-bold text-mist-0">{s.totalScore.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-mist-3 mb-1">
                    <span>
                      {s.entry.class_rank ?? "-"} / {s.entry.kyakushitsu ?? "-"}
                    </span>
                    {s.entry.line_group != null && (
                      <span className="px-1.5 py-0.5 rounded bg-white/[.06]">
                        ライングループ{s.entry.line_group} ・ {s.entry.line_position}
                      </span>
                    )}
                  </div>
                  {(soloWinRate || lineRankLabel || highStanding) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-mist-5 mb-2">
                      {soloWinRate && (
                        <span>
                          単騎勝率{soloWinRate.winRate.toFixed(1)}%(n={soloWinRate.races})
                          {soloWinRate.races < SOLO_MIN_RACES ? "・母数少" : ""}（参考値・スコア未反映）
                        </span>
                      )}
                      {lineRankLabel && (
                        <span>
                          先頭より{lineRankLabel}（{s.entry.class_rank} vs {senko?.entry.class_rank}）（参考値・スコア未反映）
                        </span>
                      )}
                      {highStanding && (
                        <span>
                          好スタート実績{s.entry.standing_count}回・自分の先頭を上回る率47%台（下位は39%台、母数16,315件で実測。参考値・スコア未反映）
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <ScoreBar label="ライン" score={s.lineScore.score} />
                    <ScoreBar label="脚質実力" score={s.kyakushitsuScore.score} />
                    <ScoreBar label="データ統計" score={s.statsScore.score} />
                  </div>
                </div>
              );
            })}
          </div>
        </details>

        {raceFinished && (
          <section className="rounded-[20px] bg-ink-2 border border-white/[.06] p-4 flex flex-col gap-2 mb-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-mist-2 bg-white/[.08] px-2 py-0.5 rounded-full">結果</span>
              {actualCombo && (
                <span className="font-mono text-sm font-bold text-mist-0">{actualCombo}</span>
              )}
              {sanrentanHitOdds != null && (
                <span className="text-xs text-mist-4 ml-auto">
                  3連単 {sanrentanHitOdds.toFixed(1)}倍（{(100 * sanrentanHitOdds).toFixed(0)}円）
                </span>
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {top3Results.map((r) => (
                <li key={r.car_num} className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-mist-4 w-8 shrink-0">{r.finish_pos}着</span>
                  <CarNumberBadge carNum={r.car_num} size="sm" />
                  <Link href={`/racers/${snumByCarNum.get(r.car_num)}`} className="text-mist-0 underline">
                    {nameByCarNum.get(r.car_num) ?? "-"}
                  </Link>
                  {r.finish_pos === 1 && r.kimarite && (
                    <span className="text-xs text-mist-4 ml-auto">{r.kimarite}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {winSuggestion && (
          <section className="rounded-[20px] bg-ink-3 border border-gold/[.18] p-4 flex flex-col gap-1 mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-gold-ink bg-gold px-2 py-0.5 rounded-full">単勝おすすめ</span>
              <span className="text-sm font-semibold text-mist-0">
                軸 {winSuggestion.carNum}.{" "}
                <Link href={`/racers/${snumByCarNum.get(winSuggestion.carNum)}`} className="underline">
                  {winSuggestion.name}
                </Link>
              </span>
              {raceFinished && <ResultBadge hit={winnerCarNum === winSuggestion.carNum} />}
            </div>
            <p className="text-xs text-mist-3">
              対抗とのスコア差が{winSuggestion.margin.toFixed(1)}点あり、この条件では単勝的中率が高い傾向（実績81.7%以上）です。3連単を広げるより単勝で勝負するのもおすすめです。
            </p>
          </section>
        )}

        <div className="flex items-center gap-2 px-1 mb-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-mint" />
          <span className="text-sm font-bold text-mist-0">買い目提案</span>
          <span className="text-[11px] text-mist-4 flex-1">展開の分かれ目ごと（参考値）</span>
        </div>

        {scenarios.length === 0 ? (
          <p className="text-sm text-mist-3">出走数が少ないため買い目候補は生成されません。</p>
        ) : (
          <div className="flex flex-col gap-3">
            {scenarios.map((scenario) => {
              const notation = formatFormationNotation(scenario.formation.combinations);
              const stat = scenarioStats[scenario.label];
              const scenarioHit =
                raceFinished && actualCombo != null ? scenario.formation.combinations.includes(actualCombo) : null;
              const scenarioStakeYen = 100 * scenario.formation.combinations.length;
              const scenarioPayoutYen = scenarioHit && sanrentanHitOdds != null ? 100 * sanrentanHitOdds : 0;
              const rankStat = scenario.label !== "本命" ? scenarioRankStats[scenario.likelyRank] : undefined;
              const isHonmei = scenario.label === "本命";
              const border = isHonmei ? "border-mint/[.22]" : "border-white/[.06]";
              const formulaColor = isHonmei ? "text-mint" : "text-mist-1";
              return (
                <section key={scenario.label} className={`rounded-[20px] bg-ink-3 border ${border} p-4 flex flex-col gap-3`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[11px] font-bold px-2.5 py-1 rounded-lg ${
                        isHonmei ? "text-mint-ink bg-mint" : "text-mist-1 bg-white/[.08]"
                      }`}
                    >
                      {scenario.label}
                    </span>
                    <span className="text-sm font-bold text-mist-0 flex-1">
                      軸 {scenario.axisCarNum}.{" "}
                      <Link href={`/racers/${snumByCarNum.get(scenario.axisCarNum)}`} className="underline">
                        {scenario.axisName}
                      </Link>
                    </span>
                    <span className="font-mono text-xs text-mist-4">
                      {scenario.formation.combinations.length}点
                    </span>
                    {scenarioHit != null && <ResultBadge hit={scenarioHit} />}
                  </div>

                  {scenarioHit != null && (
                    <p className="text-xs text-mist-3">
                      買い目 {scenarioStakeYen}円 ・ 払戻 {scenarioPayoutYen.toFixed(0)}円 ・ 回収率{" "}
                      <span className={scenarioPayoutYen >= scenarioStakeYen ? "text-mint font-semibold" : ""}>
                        {((scenarioPayoutYen / scenarioStakeYen) * 100).toFixed(0)}%
                      </span>
                    </p>
                  )}

                  {scenario.likelyRank >= 2 && (
                    <p className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          scenario.likelyRank === 2 ? "text-gold-ink bg-gold" : "text-mist-4 bg-white/[.07]"
                        }`}
                      >
                        {scenario.likelyRank === 2 ? "このレースでは本命に次ぐ有力な展開" : "このレースでは可能性低め"}
                      </span>
                      {rankStat && rankStat.races > 0 && (
                        <span className="text-[11px] text-mist-4">
                          同じ有力度の過去実績: 的中率{rankStat.hitRate.toFixed(1)}%・回収率
                          {rankStat.roi?.toFixed(0) ?? "-"}%（{rankStat.races}件中{rankStat.hits}回）
                        </span>
                      )}
                    </p>
                  )}

                  <p className="text-xs text-mist-3 leading-relaxed">{scenario.reason}</p>

                  {stat && stat.races > 0 && (
                    <p className="text-xs">
                      <span className={stat.roi != null && stat.roi >= 100 ? "text-mint font-semibold" : "text-mist-4"}>
                        実績: 的中{stat.hitRate.toFixed(1)}%
                        {stat.roi != null ? ` / 回収率${stat.roi.toFixed(0)}%` : ""}（過去{stat.races}レース中{stat.hits}回的中）
                      </span>
                    </p>
                  )}

                  {notation && (
                    <div className="flex flex-col gap-1">
                      <span className={`font-mono text-[28px] font-medium leading-none ${formulaColor}`}>{notation}</span>
                      <span className="text-[10px] text-mist-5">軸 - 2着候補 - 3着候補（購入時そのまま入力可）</span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    {scenario.formation.combinations.map((combo) => (
                      <span key={combo} className="px-2.5 py-1.5 rounded-[10px] bg-white/5 font-mono text-[13px] text-mist-1">
                        {combo}
                      </span>
                    ))}
                  </div>
                </section>
              );
            })}

            {boxSuggestion && boxSuggestion.combinations.length > 0 && (
              <section className="rounded-[20px] bg-ink-3 border border-white/[.06] p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-mist-0 flex-1">{boxSuggestion.betType}</span>
                  <span className="font-mono text-xs text-mist-4">{boxSuggestion.combinations.length}点</span>
                  {raceFinished && sortedActualTop3 != null && (
                    <ResultBadge hit={boxSuggestion.combinations.includes(sortedActualTop3)} />
                  )}
                </div>
                <p className="text-xs text-mist-3">
                  展開に依らず上位{top4.length}車を総当たり（決着順を絞らない保険的な買い方）
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {boxSuggestion.combinations.map((combo) => (
                    <span key={combo} className="px-2.5 py-1.5 rounded-[10px] bg-white/5 font-mono text-[13px] text-mist-1">
                      {combo}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
