// 競輪の車番（＝選手の帽子色）の配色規則に合わせたバッジ。
const CAR_COLOR_CLASSES: Record<number, string> = {
  1: "bg-white text-black border border-black",
  2: "bg-black text-white",
  3: "bg-red-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-yellow-400 text-black",
  6: "bg-green-600 text-white",
  7: "bg-orange-500 text-white",
  8: "bg-pink-400 text-black",
  9: "bg-purple-600 text-white",
};

export function CarNumberBadge({ carNum, size = "md" }: { carNum: number; size?: "sm" | "md" }) {
  const colorClass = CAR_COLOR_CLASSES[carNum] ?? "bg-gray-400 text-white";
  const sizeClass = size === "sm" ? "w-6 h-6 text-xs" : "w-8 h-8 text-sm";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 ${sizeClass} ${colorClass}`}
    >
      {carNum}
    </span>
  );
}
