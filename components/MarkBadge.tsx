// 印（◎○▲△×）ごとの色分け。Claude Designモックアップに合わせて、丸バッジではなく
// 車番バッジの隣に添える色つきの記号そのもので表す（車番バッジと役割が重複しないよう）。
const MARK_COLORS: Record<string, string> = {
  "◎": "#FF5D73", // rose
  "○": "#5B9CFF", // blue
  "▲": "#3DDC97", // mint
  "△": "#F5B544", // gold
  "×": "#5E6773",
};

export function MarkBadge({ mark }: { mark: string }) {
  const color = MARK_COLORS[mark] ?? "#5E6773";
  return (
    <span
      className="inline-flex items-center justify-center w-5 text-base font-bold shrink-0"
      style={{ color }}
    >
      {mark}
    </span>
  );
}
