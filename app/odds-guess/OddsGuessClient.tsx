"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CarNumberBadge } from "../../components/CarNumberBadge";
import {
  carShares,
  excludedRoundStakes,
  findCandidates,
  isValidInput,
  shapeHint,
  stakeCandidates,
  STAKE_TIER_LABEL,
  type Candidate,
  type StakeTier,
} from "../../lib/odds-guess/match";
import { BET_TYPES, BET_TYPE_LABEL, isOrdered, type BetType, type RaceOdds, type VenueOption } from "../../lib/odds-guess/types";

const RACE_NUMBERS = Array.from({ length: 12 }, (_, i) => i + 1);
const TOTAL_PRESETS = [1000, 3000, 5000, 10000];
const SELECTABLE_TIERS: Exclude<StakeTier, "fixed">[] = ["A", "B", "C"];
const TIER_CLASS: Record<StakeTier, string> = {
  fixed: "text-mint-ink bg-mint",
  A: "text-gold-ink bg-gold",
  B: "text-[#2a1200] bg-[#ff9a3d]",
  C: "text-mist-1 bg-white/[.1]",
};
const INITIAL_SHOWN = 10;

const jstTime = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
const jstTimeSec = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** 全角数字・カンマ・「円」混じりの入力を整数に。空や不正ならNaN。 */
function parseYen(text: string): number {
  const ascii = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const digits = ascii.replace(/[^\d]/g, "");
  return digits === "" ? NaN : Number(digits);
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function dateLabel(date: string, today: string): string {
  const md = `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))}`;
  return date === today ? `今日 ${md}` : md;
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

const venueKey = (v: VenueOption) => `${v.cupId}-${v.index}`;

/** 2番（黒）は暗い背景に溶けるので、このページでは薄い縁取りを付ける。 */
function Car({ car }: { car: number }) {
  if (car !== 2) return <CarNumberBadge carNum={car} size="sm" />;
  return (
    <span className="inline-flex rounded-full ring-1 ring-white/30">
      <CarNumberBadge carNum={car} size="sm" />
    </span>
  );
}

function Combo({ cars, ordered }: { cars: number[]; ordered: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {cars.map((car, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-[11px] text-mist-4">{ordered ? "-" : "="}</span>}
          <Car car={car} />
        </Fragment>
      ))}
    </span>
  );
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="bg-ink-3 border border-white/[.06] rounded-2xl p-4 mb-3">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-mist-0">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-[10px] text-[13px] font-bold transition-colors ${
        active ? "bg-mint text-mint-ink" : "bg-white/[.06] text-mist-2 active:bg-white/[.12]"
      }`}
    >
      {children}
    </button>
  );
}

function YenInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold text-mist-3">{label}</span>
      <div className="mt-1 flex items-center bg-ink-1 border border-white/[.08] rounded-xl px-3 focus-within:border-mint/60">
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-transparent py-2.5 text-base font-mono text-mist-0 outline-none placeholder:text-mist-5"
        />
        <span className="text-sm text-mist-3">円</span>
      </div>
    </label>
  );
}

export function OddsGuessClient() {
  const [venues, setVenues] = useState<VenueOption[] | null>(null);
  const [venuesError, setVenuesError] = useState<string | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<VenueOption | null>(null);
  const [selectedRace, setSelectedRace] = useState<number | null>(null);
  const [raceOdds, setRaceOdds] = useState<RaceOdds | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const [betType, setBetType] = useState<BetType>("trifecta");
  const [points, setPoints] = useState(1);
  const [totalText, setTotalText] = useState("10,000");
  const [maxPayoutText, setMaxPayoutText] = useState("");
  const [tolerance, setTolerance] = useState(0.1);
  const [tiers, setTiers] = useState<StakeTier[]>(["A", "B"]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch("/api/odds-guess/venues")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "開催一覧を取得できませんでした");
        setVenues(json.venues as VenueOption[]);
      })
      .catch((e: unknown) => setVenuesError(e instanceof Error ? e.message : "開催一覧を取得できませんでした"));
  }, []);

  const loadOdds = useCallback(async (venue: VenueOption, race: number) => {
    const seq = ++requestSeq.current;
    setOddsLoading(true);
    setOddsError(null);
    try {
      const query = new URLSearchParams({ slug: venue.slug, cupId: venue.cupId, index: String(venue.index), race: String(race) });
      const res = await fetch(`/api/odds-guess/odds?${query}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(json.error ?? "オッズを取得できませんでした");
      setRaceOdds(json.odds as RaceOdds);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setRaceOdds(null);
      setOddsError(e instanceof Error ? e.message : "オッズを取得できませんでした");
    } finally {
      if (seq === requestSeq.current) setOddsLoading(false);
    }
  }, []);

  const selectVenue = (venue: VenueOption) => {
    const race = venue.currentRace ?? 1;
    setSelectedVenue(venue);
    setSelectedRace(race);
    setShowAll(false);
    void loadOdds(venue, race);
  };

  const selectRace = (race: number) => {
    if (!selectedVenue) return;
    setSelectedRace(race);
    setShowAll(false);
    void loadOdds(selectedVenue, race);
  };

  const total = parseYen(totalText);
  const maxPayout = parseYen(maxPayoutText);
  const inputOk = isValidInput(total, points, maxPayout);
  const ordered = isOrdered(betType);

  const stakes = useMemo(() => (inputOk ? stakeCandidates(total, points, maxPayout) : []), [inputOk, total, points, maxPayout]);
  const excluded = useMemo(() => (inputOk ? excludedRoundStakes(total, points, maxPayout) : []), [inputOk, total, points, maxPayout]);
  const entries = useMemo(() => raceOdds?.odds[betType] ?? [], [raceOdds, betType]);
  const candidates = useMemo(
    () => findCandidates(entries, stakes, { tolerance, tiers, betType, lines: raceOdds?.lines ?? [] }),
    [entries, stakes, tolerance, tiers, betType, raceOdds],
  );
  const cars = useMemo(() => (raceOdds?.entries ?? []).filter((e) => !e.absent).map((e) => e.number), [raceOdds]);
  const shares = useMemo(() => {
    const rows = carShares(candidates, betType, cars);
    return rows.sort((a, b) => (ordered ? b.byPos[0] - a.byPos[0] : b.any - a.any) || b.any - a.any);
  }, [candidates, betType, cars, ordered]);
  const names = useMemo(() => new Map((raceOdds?.entries ?? []).map((e) => [e.number, e.name])), [raceOdds]);

  const today = todayJst();
  const venuesByDate = useMemo(() => {
    const groups = new Map<string, VenueOption[]>();
    for (const v of venues ?? []) groups.set(v.date, [...(groups.get(v.date) ?? []), v]);
    return [...groups.entries()];
  }, [venues]);

  const toggleTier = (tier: StakeTier) =>
    setTiers((prev) => (prev.includes(tier) ? prev.filter((t) => t !== tier) : [...prev, tier]));

  const shownCandidates = showAll ? candidates : candidates.slice(0, INITIAL_SHOWN);
  const topWeight = candidates[0]?.weight ?? 1;
  const posLabels = betType === "trifecta" ? ["1着", "2着", "3着"] : betType === "exacta" ? ["1着", "2着"] : [];

  return (
    <main className="bg-ink-0 flex-1">
      <div className="max-w-lg mx-auto w-full px-4 py-4">
        <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-white/[.06]">
          <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-gold to-[#a8701a] flex items-center justify-center text-[13px] font-black text-gold-ink">
            ¥
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-base font-bold text-mist-0">オッズ逆算</span>
            <span className="text-[10px] text-mist-3">予想家の最高想定払戻から買い目の当たりをつける</span>
          </div>
        </div>

        <Card title="レース">
          {venuesError && <p className="text-sm text-rose-soft">{venuesError}</p>}
          {!venues && !venuesError && <p className="text-sm text-mist-3">開催一覧を読み込み中…</p>}
          {venues && venues.length === 0 && <p className="text-sm text-mist-3">今日・明日の開催が見つかりませんでした。</p>}
          {venuesByDate.map(([date, group]) => (
            <div key={date} className="mb-3 last:mb-0">
              <div className="text-[11px] font-bold text-mist-3 mb-1.5">{dateLabel(date, today)}</div>
              <div className="flex flex-wrap gap-1.5">
                {group.map((v) => (
                  <Chip key={venueKey(v)} active={selectedVenue != null && venueKey(selectedVenue) === venueKey(v)} onClick={() => selectVenue(v)}>
                    {v.venueName}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          {selectedVenue && (
            <div className="grid grid-cols-6 gap-1.5 mt-3 pt-3 border-t border-white/[.06]">
              {RACE_NUMBERS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={selectedRace === n}
                  onClick={() => selectRace(n)}
                  className={`relative py-2 rounded-[10px] text-sm font-bold font-mono ${
                    selectedRace === n ? "bg-mint text-mint-ink" : "bg-white/[.06] text-mist-2 active:bg-white/[.12]"
                  }`}
                >
                  {n}R
                  {selectedVenue.currentRace === n && selectedRace !== n && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-mint" aria-label="次のレース" />
                  )}
                </button>
              ))}
            </div>
          )}
        </Card>

        {selectedVenue && (
          <section className="bg-ink-2 border border-white/[.06] rounded-2xl p-4 mb-3">
            {oddsLoading && <p className="text-sm text-mist-3">オッズを取得中…</p>}
            {!oddsLoading && oddsError && <p className="text-sm text-rose-soft">{oddsError}</p>}
            {!oddsLoading && raceOdds && (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-bold text-mist-0">
                      {raceOdds.venueName} {raceOdds.race.number}R
                      <span className="ml-2 text-sm font-medium text-mist-2">
                        {raceOdds.race.className} {raceOdds.race.raceType}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-mist-3 mt-0.5">
                      締切 {raceOdds.race.closeAt ? jstTime.format(raceOdds.race.closeAt * 1000) : "-"}
                      {" ・ "}
                      {raceOdds.finalOdds
                        ? "確定オッズ"
                        : raceOdds.oddsUpdatedAt
                          ? `オッズ ${jstTimeSec.format(raceOdds.oddsUpdatedAt * 1000)} 時点`
                          : "オッズ未発売"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectedRace != null && loadOdds(selectedVenue, selectedRace)}
                    className="shrink-0 px-3 py-1.5 rounded-[10px] bg-white/[.06] text-[12px] font-bold text-mist-1 active:bg-white/[.12]"
                  >
                    再取得
                  </button>
                </div>
                {raceOdds.race.cancel && <p className="text-sm text-rose-soft mt-2">このレースは中止です。</p>}
                {raceOdds.lines.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3">
                    <span className="text-[11px] text-mist-3">{raceOdds.lineType || "ライン"}</span>
                    {raceOdds.lines.map((line, i) => (
                      <span key={i} className="inline-flex items-center gap-0.5">
                        {line.map((car) => (
                          <Car key={car} car={car} />
                        ))}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <Card title="予想家の情報">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {BET_TYPES.map((t) => (
              <Chip key={t} active={betType === t} onClick={() => setBetType(t)}>
                {BET_TYPE_LABEL[t]}
              </Chip>
            ))}
          </div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-mist-3">点数</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="点数を減らす"
                onClick={() => setPoints((p) => Math.max(1, p - 1))}
                className="w-9 h-9 rounded-[10px] bg-white/[.06] text-mist-1 text-lg active:bg-white/[.12]"
              >
                −
              </button>
              <span className="w-12 text-center text-lg font-bold font-mono text-mist-0">{points}点</span>
              <button
                type="button"
                aria-label="点数を増やす"
                onClick={() => setPoints((p) => Math.min(30, p + 1))}
                className="w-9 h-9 rounded-[10px] bg-white/[.06] text-mist-1 text-lg active:bg-white/[.12]"
              >
                ＋
              </button>
            </div>
          </div>
          <YenInput label="購入金額" value={totalText} onChange={setTotalText} placeholder="10,000" />
          <div className="flex flex-wrap gap-1.5 mt-1.5 mb-3">
            {TOTAL_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setTotalText(v.toLocaleString("ja-JP"))}
                className="px-2.5 py-1 rounded-lg bg-white/[.05] text-[11px] font-mono text-mist-2 active:bg-white/[.12]"
              >
                {v.toLocaleString("ja-JP")}
              </button>
            ))}
          </div>
          <YenInput label="最高想定払戻" value={maxPayoutText} onChange={setMaxPayoutText} placeholder="349,300" />

          <div className="mt-4 pt-3 border-t border-white/[.06]">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-mist-3">オッズの許容幅（公開時点からのズレ）</span>
              <span className="text-sm font-mono font-bold text-mist-0">±{Math.round(tolerance * 100)}%</span>
            </div>
            <input
              type="range"
              min={3}
              max={40}
              step={1}
              value={Math.round(tolerance * 100)}
              onChange={(e) => setTolerance(Number(e.target.value) / 100)}
              className="w-full mt-1 accent-[#3ddc97]"
              aria-label="オッズの許容幅"
            />
            {points >= 2 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <span className="text-[11px] font-bold text-mist-3 mr-1">賭け金の候補</span>
                {SELECTABLE_TIERS.map((tier) => (
                  <Chip key={tier} active={tiers.includes(tier)} onClick={() => toggleTier(tier)}>
                    {STAKE_TIER_LABEL[tier]}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        </Card>

        {!inputOk && (
          <p className="text-[12px] text-mist-3 px-1 mb-3">
            購入金額と最高想定払戻を入れると、ここに推定が出ます。
          </p>
        )}

        {inputOk && (
          <Card title="推定オッズ">
            <div className="flex flex-col gap-1.5">
              {stakes.map((s) => {
                const active = s.tier === "fixed" || tiers.includes(s.tier);
                return (
                  <div key={s.stake} className={`flex items-center gap-2 text-[13px] ${active ? "" : "opacity-40"}`}>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md whitespace-nowrap ${TIER_CLASS[s.tier]}`}>
                      {STAKE_TIER_LABEL[s.tier]}
                    </span>
                    <span className="font-mono text-mist-2">{yen(s.stake)}</span>
                    <span className="text-mist-4">→</span>
                    <span className="font-mono font-bold text-mist-0">{s.targetOdds.toFixed(s.exact ? 1 : 2)}倍</span>
                  </div>
                );
              })}
              {stakes.length === 0 && <p className="text-sm text-mist-3">成立する賭け金がありません。金額を確かめてください。</p>}
            </div>
            {stakes.length === 1 && !stakes[0].exact && (
              <p className="text-[11px] text-rose-soft mt-2">
                最高想定払戻が購入金額で割り切れません（0.1倍刻みのオッズにならない）。入力を確かめてください。
              </p>
            )}
            {excluded.length > 0 && (
              <p className="text-[11px] text-mist-3 mt-2 leading-relaxed">
                {excluded.map((v) => v.toLocaleString("ja-JP")).join("・")}円は割り切れないので除外
              </p>
            )}
          </Card>
        )}

        {inputOk && raceOdds && entries.length === 0 && (
          <p className="text-sm text-mist-3 px-1 mb-3">{BET_TYPE_LABEL[betType]}のオッズがまだ出ていません。</p>
        )}

        {inputOk && raceOdds && entries.length > 0 && (
          <>
            <Card title="軸の当たり" aside={<span className="text-[10px] text-mist-4">候補の重みを車番ごとに集計</span>}>
              {candidates.length === 0 ? (
                <p className="text-sm text-mist-3">候補がありません。許容幅を広げるか、賭け金の候補を増やしてください。</p>
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-mist-4">
                      <th className="text-left font-medium pb-1.5">車番</th>
                      {posLabels.length > 0 ? (
                        posLabels.map((l) => (
                          <th key={l} className="text-right font-medium pb-1.5 w-12">
                            {l}
                          </th>
                        ))
                      ) : (
                        <th className="text-right font-medium pb-1.5">絡み</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {shares.map((row, i) => {
                      const main = ordered ? row.byPos[0] : row.any;
                      return (
                        <tr key={row.car} className="border-t border-white/[.04]">
                          <td className="py-1.5">
                            <div className="flex items-center gap-2">
                              <Car car={row.car} />
                              <span className="text-mist-1 truncate max-w-[7rem]">{names.get(row.car)}</span>
                              {i === 0 && main > 0 && (
                                <span className="text-[10px] font-bold text-mint-ink bg-mint px-1.5 py-0.5 rounded-md">軸候補</span>
                              )}
                            </div>
                            <div className="h-1 mt-1 rounded-full bg-white/[.05] overflow-hidden">
                              <div className="h-full bg-mint/70" style={{ width: pct(Math.min(1, main)) }} />
                            </div>
                          </td>
                          {posLabels.length > 0 ? (
                            row.byPos.map((v, j) => (
                              <td key={j} className={`text-right font-mono ${j === 0 ? "text-mist-0 font-bold" : "text-mist-2"}`}>
                                {pct(v)}
                              </td>
                            ))
                          ) : (
                            <td className="text-right font-mono text-mist-0 font-bold">{pct(row.any)}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>

            {candidates.length > 0 && (
              <Card title="買い目の候補" aside={<span className="text-[10px] text-mist-4">全{candidates.length}件</span>}>
                <ol className="flex flex-col">
                  {shownCandidates.map((c, i) => (
                    <CandidateRow
                      key={c.key.join("-")}
                      rank={i + 1}
                      candidate={c}
                      ordered={ordered}
                      topWeight={topWeight}
                      hint={
                        i < 3 && points >= 2
                          ? shapeHint(c, entries, { betType, total, points, maxPayout, limit: Math.max(3, points + 1) })
                          : null
                      }
                      remainingPoints={points - 1}
                    />
                  ))}
                </ol>
                {candidates.length > INITIAL_SHOWN && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="w-full mt-2 py-2 rounded-[10px] bg-white/[.05] text-[12px] font-bold text-mist-2 active:bg-white/[.12]"
                  >
                    {showAll ? "上位だけ表示" : `残り${candidates.length - INITIAL_SHOWN}件も表示`}
                  </button>
                )}
              </Card>
            )}
          </>
        )}

        <p className="text-[11px] text-mist-4 leading-relaxed px-1 mt-2 mb-4">
          最高想定払戻 ＝ 最高払戻になる1点のオッズ × その賭け金。想定払戻は予想の公開時点のオッズで計算されているため、
          公開から時間が経つほど今のオッズとズレます。候補は「当たり」をつけるためのもので、買い目を確定するものではありません。
        </p>
      </div>
    </main>
  );
}

function CandidateRow({
  rank,
  candidate: c,
  ordered,
  topWeight,
  hint,
  remainingPoints,
}: {
  rank: number;
  candidate: Candidate;
  ordered: boolean;
  topWeight: number;
  hint: ReturnType<typeof shapeHint>;
  remainingPoints: number;
}) {
  const diff = c.ratio - 1;
  return (
    <li className="py-2.5 border-t border-white/[.05] first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="w-5 text-[11px] font-mono text-mist-4 text-right">{rank}</span>
        <Combo cars={c.key} ordered={ordered} />
        <div className="ml-auto text-right">
          <div className="text-sm font-mono font-bold text-mist-0">{c.odds.toFixed(1)}倍</div>
          <div className="text-[10px] font-mono text-mist-3">{c.popularity}人気</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mt-1.5 pl-7 text-[10px]">
        <span className={`font-bold px-1.5 py-0.5 rounded-md ${TIER_CLASS[c.tier]}`}>
          {yen(c.stake)}→{c.targetOdds.toFixed(1)}倍
        </span>
        <span className={`font-mono ${Math.abs(diff) <= 0.03 ? "text-mint" : "text-mist-3"}`}>
          ズレ{diff >= 0 ? "+" : ""}
          {(diff * 100).toFixed(1)}%
        </span>
        {c.lineMatch && <span className="font-bold text-mint bg-mint/10 px-1.5 py-0.5 rounded-md">ライン筋</span>}
        <span className="ml-auto h-1 w-16 rounded-full bg-white/[.05] overflow-hidden">
          <span className="block h-full bg-gold/80" style={{ width: pct(c.weight / topWeight) }} />
        </span>
      </div>
      {hint && (
        <div className="mt-2 ml-7 rounded-xl bg-ink-1 border border-white/[.05] px-3 py-2">
          <div className="text-[10px] text-mist-3">
            残り{remainingPoints}点・{yen(hint.remaining)}（均等なら{hint.capOdds.toFixed(1)}倍以下）の形の候補
          </div>
          {hint.related.length === 0 ? (
            <div className="text-[11px] text-mist-4 mt-1">同じ形で条件に合う買い目はありません</div>
          ) : (
            <div className="flex flex-col gap-1 mt-1.5">
              {hint.related.map((r) => (
                <div key={r.key.join("-")} className="flex items-center gap-2">
                  <Combo cars={r.key} ordered={ordered} />
                  <span className="text-[10px] text-mist-4">{r.relation}</span>
                  <span className="ml-auto text-[12px] font-mono text-mist-1">{r.odds.toFixed(1)}倍</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
