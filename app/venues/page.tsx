import Link from "next/link";
import { getAllBankInfo } from "../../lib/repository";

export const dynamic = "force-dynamic";

const KIMARITE_BAR_COLORS: Record<string, string> = {
  逃げ: "#5B9CFF",
  捲り: "#F5B544",
  差し: "#FF5D73",
};

// KEIRIN.JPのjyoguideから取得した値はHTMLエンティティのまま保存されている
// （&deg;=°、&prime;=′、&Prime;=″、feature_textは&lt;br /&gt;=改行も含む）
// ので表示用に変換する。
function decodeHtmlText(text: string): string {
  return text
    .replace(/&lt;br\s*\/?&gt;/g, "\n")
    .replace(/&deg;/g, "°")
    .replace(/&Prime;/g, "″")
    .replace(/&prime;/g, "′")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export default async function VenuesPage() {
  const venues = await getAllBankInfo();

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <Link href="/" className="text-sm text-mint mb-2 inline-block">
        ← ホームに戻る
      </Link>
      <h1 className="text-lg font-black text-mist-0 mb-1">開催場データ</h1>
      <p className="text-[11px] text-mist-3 mb-4">
        周長・直線・逃げ/捲り/差し割合（KEIRIN.JP掲載の参考値）。全{venues.length}場、周長順。
      </p>

      <ul className="flex flex-col gap-2.5">
        {venues.map((v) => {
          const hasRates = v.nige_pct != null && v.makuri_pct != null && v.sashi_pct != null;
          return (
            <li key={v.jocd}>
              <Link
                href={`/venues/${v.jocd}`}
                className="block rounded-[18px] bg-ink-3 border border-white/[.06] p-3.5 active:bg-ink-2"
              >
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-[15px] font-bold text-mist-0">{v.keirinjo_name}</span>
                  <span className="font-mono text-[12px] text-mist-2 shrink-0">
                    {v.shuutyou != null ? `周長${v.shuutyou}m` : "周長不明"}
                    {v.tyokusen && ` ・直線${v.tyokusen}`}
                  </span>
                </div>

                {hasRates && (
                  <>
                    <div className="flex h-1.5 rounded-[4px] overflow-hidden gap-0.5 mb-1.5">
                      <div style={{ width: `${v.nige_pct}%`, background: KIMARITE_BAR_COLORS.逃げ }} />
                      <div style={{ width: `${v.makuri_pct}%`, background: KIMARITE_BAR_COLORS.捲り }} />
                      <div style={{ width: `${v.sashi_pct}%`, background: KIMARITE_BAR_COLORS.差し }} />
                    </div>
                    <div className="flex gap-3 text-[11px] text-mist-2 mb-1.5">
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: KIMARITE_BAR_COLORS.逃げ }} />
                        逃げ{v.nige_pct!.toFixed(0)}%
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: KIMARITE_BAR_COLORS.捲り }} />
                        捲り{v.makuri_pct!.toFixed(0)}%
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: KIMARITE_BAR_COLORS.差し }} />
                        差し{v.sashi_pct!.toFixed(0)}%
                      </span>
                    </div>
                  </>
                )}

                {(v.kant || v.home_hukuin) && (
                  <p className="text-[10px] text-mist-3 font-mono mb-1">
                    {v.kant && `カント${decodeHtmlText(v.kant)}`}
                    {v.tkant && `(直線${decodeHtmlText(v.tkant)})`}
                    {v.home_hukuin && ` ・ホーム副走${v.home_hukuin}`}
                    {v.back_hukuin && ` ・バック副走${v.back_hukuin}`}
                  </p>
                )}

                {v.feature_text && (
                  <p className="text-[11px] text-mist-3 leading-relaxed whitespace-pre-line">
                    {decodeHtmlText(v.feature_text)}
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
