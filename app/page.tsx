import Link from "next/link";
import { getAllRaces } from "../lib/repository";
import { ScrapeTriggerForm } from "../components/ScrapeTriggerForm";

function formatDate(kaisaiDate: string): string {
  const y = kaisaiDate.slice(0, 4);
  const m = kaisaiDate.slice(4, 6);
  const d = kaisaiDate.slice(6, 8);
  return `${y}/${m}/${d}`;
}

export default async function Home() {
  const races = await getAllRaces();

  // 開催日＋開催場ごとにグルーピング
  const groups = new Map<string, typeof races>();
  for (const race of races) {
    const key = `${race.kaisai_date}_${race.keirinjo_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(race);
  }

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-4">レース一覧</h1>

      <ScrapeTriggerForm />

      {races.length === 0 ? (
        <p className="text-center text-gray-500 mt-8">
          レースがまだ登録されていません。上のフォームから取得してください。
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([key, groupRaces]) => {
            const first = groupRaces[0];
            return (
              <section key={key} className="bg-white rounded-lg shadow-sm overflow-hidden">
                <div className="bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700">
                  {formatDate(first.kaisai_date)} {first.keirinjo_name}
                </div>
                <ul className="divide-y divide-gray-100">
                  {groupRaces.map((race) => (
                    <li key={race.id}>
                      <Link
                        href={`/races/${race.id}`}
                        className="flex items-center justify-between px-4 py-3 active:bg-gray-50"
                      >
                        <span className="font-medium text-gray-900">{race.race_no}R</span>
                        <span className="text-sm text-gray-500">
                          {race.syumoku ?? ""} {race.grade_kbn ?? ""}
                        </span>
                        <span className="text-sm text-gray-400">{race.start_time ?? ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
