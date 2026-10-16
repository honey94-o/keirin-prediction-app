/**
 * 画面表示用のDB読み取りキャッシュ（Next.jsのデータキャッシュ）。
 *
 * 以前は全ページがforce-dynamicで、表示のたびに米国東部のサーバーからNeonへ
 * 数十〜数百クエリを投げていた（ホーム画面は終了済み厳選ごとにpredictRaceを実行）。
 * データが変わるのはGitHub Actionsの同期時と、画面からの設定・お気に入り変更時だけ
 * なので、読み取り結果をタグ付きでキャッシュし、変わった時にだけ捨てる：
 *   - 同期ジョブ → app/api/revalidate/route.ts に対象タグを送って即時失効
 *   - 設定・お気に入りのServer Action → updateTag で即時失効
 * 失効の呼び出しが万一失敗しても古いまま残り続けないよう、SAFETY_TTL_SECで自動更新もする。
 *
 * 注意: キャッシュはJSONで保存されるため、ラップする関数は Map/Set/Date を返さないこと
 * （必要なら呼び出し側で Map に戻す）。lib/repository.ts は scripts/ からも使うので、
 * キャッシュはこのファイル（app/ からだけ使う）で被せ、repository 側には入れない。
 */
import { unstable_cache } from "next/cache";
import { predictRace, type RacePrediction } from "./predict";

export const CACHE_TAGS = {
  /** races / entries / racers / bank_info / racer_race_history（出走表まわり。daily-syncのスクレイプ） */
  races: "races",
  /** results / odds（着順・払戻。daily-sync・sync-results・repair-gaps） */
  results: "results",
  /** daily_picks / barikata_picks / barikata_near_misses / nakaana_picks / predictions / scenario_stats 等 */
  picks: "picks",
  /** settings（スコア重み） */
  settings: "settings",
  /** favorite_racers */
  favorites: "favorites",
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];
export const ALL_CACHE_TAGS: CacheTag[] = Object.values(CACHE_TAGS);

/** 失効の呼び出しが届かなかった場合の保険（秒）。 */
const SAFETY_TTL_SEC = 600;

/**
 * DB読み取り関数をデータキャッシュに載せる。name はキャッシュキーの接頭辞で、
 * 関数ごとに一意にすること（引数は自動でキーに含まれる）。
 */
export function cachedQuery<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
  tags: CacheTag[]
): (...args: A) => Promise<R> {
  return unstable_cache(fn, [name], { tags, revalidate: SAFETY_TTL_SEC });
}

/**
 * predictRaceの結果は出走表・選手成績・着順（位置別勝率等の集計）・設定に依存する。
 * 戻り値はプレーンなオブジェクトなのでそのままキャッシュできる。
 */
export const cachedPredictRace: (raceId: number) => Promise<RacePrediction | null> = cachedQuery(
  "predictRace",
  (raceId: number) => predictRace(raceId),
  [CACHE_TAGS.races, CACHE_TAGS.results, CACHE_TAGS.settings]
);
