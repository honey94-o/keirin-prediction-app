// 競輪の車番（＝選手の帽子色）の配色規則に合わせたバッジ。
// Claude Designモックアップ（2026-09）の配色に合わせてhexを直接指定している
// （Tailwind標準色より明度・彩度を細かく詰めた値のため、名前付きクラスに丸めない）。
const CAR_COLORS: Record<number, { bg: string; fg: string }> = {
  1: { bg: "#F4F6F8", fg: "#101317" },
  2: { bg: "#14171B", fg: "#ECEFF3" },
  3: { bg: "#E8384F", fg: "#fff" },
  4: { bg: "#2F6BEA", fg: "#fff" },
  5: { bg: "#F2C83C", fg: "#1A1405" },
  6: { bg: "#21A85B", fg: "#fff" },
  7: { bg: "#F07C2B", fg: "#fff" },
  8: { bg: "#E86FA8", fg: "#fff" },
  9: { bg: "#7C4DBE", fg: "#fff" },
};

export function CarNumberBadge({ carNum, size = "md" }: { carNum: number; size?: "sm" | "md" }) {
  const color = CAR_COLORS[carNum] ?? { bg: "#5E6773", fg: "#fff" };
  const sizeClass = size === "sm" ? "w-6 h-6 text-xs" : "w-8 h-8 text-sm";
  // 1番（背景がほぼ白）は明るいカード上でも輪郭が消えないよう縁取りしておく。
  const ringClass = carNum === 1 ? "ring-1 ring-inset ring-black/15" : "";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-medium font-mono shrink-0 ${sizeClass} ${ringClass}`}
      style={{ background: color.bg, color: color.fg }}
    >
      {carNum}
    </span>
  );
}
