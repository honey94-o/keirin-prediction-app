const MARK_COLOR_CLASSES: Record<string, string> = {
  "◎": "bg-red-600 text-white",
  "○": "bg-blue-600 text-white",
  "▲": "bg-green-600 text-white",
  "△": "bg-amber-500 text-white",
  "×": "bg-gray-300 text-gray-600 dark:bg-gray-600 dark:text-gray-300",
};

export function MarkBadge({ mark }: { mark: string }) {
  const colorClass = MARK_COLOR_CLASSES[mark] ?? "bg-gray-300 text-gray-600 dark:bg-gray-600 dark:text-gray-300";
  return (
    <span
      className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold text-lg shrink-0 ${colorClass}`}
    >
      {mark}
    </span>
  );
}
