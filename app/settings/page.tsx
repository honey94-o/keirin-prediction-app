import { getScoreWeights } from "../../lib/repository";
import { WeightSettingsForm } from "../../components/WeightSettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const weights = await getScoreWeights();

  return (
    <main className="flex-1 px-4 py-4 max-w-lg mx-auto w-full">
      <h1 className="text-lg font-bold mb-1">設定</h1>
      <p className="text-sm text-gray-500 mb-4">
        3本柱（ライン／脚質実力／データ統計）の重みを調整します。保存すると次に開く予想画面から反映されます。
      </p>
      <section className="bg-white rounded-lg shadow-sm p-4">
        <WeightSettingsForm initialWeights={weights} />
      </section>
    </main>
  );
}
