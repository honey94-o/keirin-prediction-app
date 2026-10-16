import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getRacesForEventCached,
  getVenueKimariteRatesCached,
  getVenueKimariteRankCached,
  getBankInfoCached,
  getRaceSnapshots,
} from "../../../lib/queries/home";
import { HIGH_CONFIDENCE_MARGIN } from "../../../lib/scoring";
import { todayJstStr } from "../../../lib/date";
import { BankKimariteCard } from "../../../components/BankKimariteCard";
import { StaleDateGuard } from "../../../components/StaleDateGuard";
import { IntentLink } from "../../../components/IntentLink";

// 当日の開催場別レース選択。ISR（app/page.tsxと同じ理由・同じ秒数）で、各開催場は
// 初回アクセス時に描画してCDNにキャッシュする（ビルド時には生成しない）。
// 以前は ?date= で日付を指定できたが、画面内にそのリンクは無く、searchParamsを読むと
// キャッシュできなくなるため当日分のみにした。
export const revalidate = 600;

export function generateStaticParams(): { jocd: string }[] {
  return [];
}

export default async function VenueRacesPage({ params }: { params: Promise<{ jocd: string }> }) {
  const { jocd } = await params;

  // 開催場選択（ステップ1）から来た当日開催分のレース選択（ステップ2）。
  const viewDate = todayJstStr();
  // 開催の無い場は決まり手の集計（results全体を読む）をせずに404にする
  // （/venuesの一覧から各場のリンクが先読みされるため、空振りの集計が積み重なる）。
  const races = await getRacesForEventCached(viewDate, jocd);
  if (races.length === 0) notFound();
  const [venueKimarite, kimariteRank, bankInfo, snapshots] = await Promise.all([
    getVenueKimariteRatesCached(jocd),
    getVenueKimariteRankCached(jocd),
    getBankInfoCached(jocd),
    getRaceSnapshots(races.map((r) => r.id)),
  ]);

  const first = races[0];

  // 予想スコアが実際に参照している決まり手データ（calculateBankFitScoreと同じ
  // 優先順位：自場/同周長グループの実績→bank_info静的値）をそのまま表示する。
  // どちらも無ければ非表示（ニュートラル50点で予想には影響していない）。
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

  // 「高信頼度」バッジ（◎と対抗のスコア差がHIGH_CONFIDENCE_MARGIN以上）。以前は全レースに
  // predictRaceを実行していたが、compute-picksが保存したスナップショットのmarginを読む。
  const highConfidenceRaceIds = new Set(
    races
      .filter((race) => {
        const margin = snapshots.get(race.id)?.margin;
        return margin != null && margin >= HIGH_CONFIDENCE_MARGIN;
      })
      .map((race) => race.id)
  );

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <StaleDateGuard renderedToday={viewDate} />
      <Link href="/" className="text-sm text-[#0d5c3f] mb-2 inline-block dark:text-emerald-400">
        ← 開催場選択に戻る
      </Link>
      <h1 className="text-lg font-bold mb-4 dark:text-gray-100">{first.keirinjo_name} レースを選択</h1>

      {kimariteRates && (
        <BankKimariteCard
          rates={kimariteRates}
          ranks={kimariteRank}
          sourceLabel={kimariteSourceLabel}
          featureText={bankInfo?.feature_text}
        />
      )}

      <ul className="flex flex-col gap-2">
        {races.map((race) => (
          <li key={race.id}>
            <IntentLink
              href={`/races/${race.id}`}
              className="flex items-center justify-between bg-white rounded-lg shadow-sm px-4 py-3 active:bg-gray-50 dark:bg-gray-800 dark:active:bg-gray-700"
            >
              <span className="font-medium text-gray-900 flex items-center gap-1.5 dark:text-gray-100">
                {race.race_no}R
                {highConfidenceRaceIds.has(race.id) && (
                  <span className="text-[10px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full dark:bg-amber-950 dark:text-amber-400">
                    高信頼度
                  </span>
                )}
              </span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {race.syumoku ?? ""} {race.grade_kbn ?? ""}
              </span>
              <span className="text-sm text-gray-400 dark:text-gray-400">{race.start_time ?? ""}</span>
            </IntentLink>
          </li>
        ))}
      </ul>
    </main>
  );
}
