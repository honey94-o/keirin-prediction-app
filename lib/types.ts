export interface RaceRow {
  id: number;
  kaisai_date: string;
  jocd: string;
  keirinjo_name: string;
  race_no: number;
  syumoku: string | null;
  grade_kbn: string | null;
  kyori: number | null;
  shukai: number | null;
  start_time: string | null;
  encp: string | null;
  tenki: string | null; // レース終了後の実績値のみ（事前予報ではない）
  husoku: number | null;
}

export interface BankInfoRow {
  jocd: string;
  keirinjo_name: string | null;
  shuutyou: number | null;
  tyokusen: string | null;
  kant: string | null;
  tkant: string | null;
  home_hukuin: string | null;
  back_hukuin: string | null;
  center_hukuin: string | null;
  nige_pct: number | null;
  makuri_pct: number | null;
  sashi_pct: number | null;
  feature_text: string | null;
}

export interface RacerRow {
  snum: string;
  name: string;
  pref: string | null;
  class_rank: string | null;
  prev_class_rank: string | null;
  kyakushitsu: string | null;
  gear_ratio: number | null;
  heikin_tokuten: number | null;
  syouritu: number | null;
  rentairitu2: number | null;
  rentairitu3: number | null;
  /** 以下4つは「1着・2着に入った際の勝ち方の回数」（WINTICKET由来のみ。KEIRIN.JP由来はnull）。 */
  kimarite_nige_count: number | null;
  kimarite_makuri_count: number | null;
  kimarite_sashi_count: number | null;
  kimarite_mark_count: number | null;
  /** 以下3つもWINTICKET出走表由来（S/H/B列）。Bは最終バックストレッチ線を
   *  先頭通過した回数、Hは最終周回ホーム線（ゴール線）を先頭通過した回数。 */
  standing_count: number | null;
  home_lead_count: number | null;
  back_lead_count: number | null;
  /** 日本競輪選手養成所（JIK）のデビュー前「記録会」データ（scraper/jik_kisokukai.py）。
   *  新人選手の実力参考指標。既存レコードには無くNULLのまま（デビュー済みでも
   *  記録会PDFを未取込の選手はNULL）。 */
  debut_class: string | null;
  tt200_sec: number | null;
  tt400_sec: number | null;
  tt1000_sec: number | null;
  tt3000_sec: number | null;
  kisokukai_grade: string | null;
}

export interface RacerHistoryRow {
  race_date: string; // "MM/DD"
  venue_abbr: string | null; // 例: "豊Ｆ２"
  finish_positions: string; // カンマ区切り "6,5,5"
}

export interface EntryWithRacer {
  entry_id: number;
  race_id: number;
  car_num: number;
  line_group: number | null;
  line_position: string | null;
  snum: string;
  name: string;
  pref: string | null;
  class_rank: string | null;
  prev_class_rank: string | null;
  kyakushitsu: string | null;
  gear_ratio: number | null;
  heikin_tokuten: number | null;
  syouritu: number | null;
  rentairitu2: number | null;
  rentairitu3: number | null;
  kimarite_nige_count: number | null;
  kimarite_makuri_count: number | null;
  kimarite_sashi_count: number | null;
  kimarite_mark_count: number | null;
  standing_count: number | null;
  home_lead_count: number | null;
  back_lead_count: number | null;
}

export interface OddsRow {
  bet_type: string;
  combination: string;
  odds_value: number | null;
}

export interface ScoreBreakdown {
  score: number; // 0-100
  factors: Record<string, number | string>;
}

export interface ScoredEntry {
  entry: EntryWithRacer;
  lineScore: ScoreBreakdown;
  kyakushitsuScore: ScoreBreakdown;
  statsScore: ScoreBreakdown;
  totalScore: number;
  mark: "◎" | "○" | "▲" | "△" | "×";
}

export interface ScoreWeights {
  line: number;
  kyakushitsu: number;
  stats: number;
}

export interface BetSuggestion {
  betType: "3連単フォーメーション" | "3連複ボックス";
  combinations: string[];
}

/**
 * レース展開の想定パターン。総合スコア最上位を機械的に軸にするだけでなく、
 * 「先頭が逃げ粘る」「番手やまくり適性の高い選手が差す」といった
 * 異なる決着シナリオごとに軸選手とフォーメーションを分けて提示する。
 */
export interface RaceScenario {
  label: string; // 例: "本命", "逃げ粘り込み", "まくり/差し一撃"
  axisCarNum: number;
  axisName: string;
  reason: string; // なぜこの選手を軸にしたかの説明文
  formation: BetSuggestion;
  /**
   * このレースにおける「展開の有力度」の順位（1が最有力）。
   * 各シナリオの軸選手の総合スコアで比較する（詳細はgenerateScenariosのコメント参照）。
   */
  likelyRank: number;
}

export interface PositionWinRate {
  line_position: string;
  races: number;
  wins: number;
  winRate: number; // 0-100
}

/**
 * 開催場ごとの決まり手（逃/捲/差）の実績割合。bank_infoテーブル（KEIRIN.JPの
 * jyoguideスクレイプ由来、ほぼ静的）とは別に、自前のresultsデータが十分
 * 貯まった開催場については、そちらから直接算出した実績値を優先して使う。
 */
export interface VenueKimariteRates {
  nige_pct: number;
  makuri_pct: number;
  sashi_pct: number;
  races: number;
}

export interface PredictionRow {
  car_num: number;
  snum: string;
  mark: string;
  total_score: number;
  line_score: number;
  kyakushitsu_score: number;
  stats_score: number;
}

export interface ResultRow {
  car_num: number;
  snum: string;
  finish_pos: number | null;
  kimarite: string | null;
}

/**
 * 展開シナリオ（本命／逃げ粘り込み／まくり差し一撃／単騎一撃）ごとの
 * バックテスト実績（scripts/backtest.ts が集計してscenario_statsテーブルに保存）。
 * 買い目提案画面で各シナリオの実績的中率・回収率を表示するために使う。
 */
export interface ScenarioStatsRow {
  label: string;
  races: number;
  hits: number;
  stakeYen: number;
  payoutYen: number;
  hitRate: number; // 0-100
  roi: number | null; // 0-100。stakeYenが0ならnull
}

export interface RaceResultSummary {
  race: RaceRow;
  entries: { car_num: number; name: string }[];
  predictions: PredictionRow[];
  results: ResultRow[];
  honmeiHit: boolean | null; // ◎が1着だったか（結果未確定ならnull）
  honmeiTop3: boolean | null; // ◎が3着以内だったか
  sanrentanHit: boolean | null; // 実際の着順が◎の3連単フォーメーションに含まれていたか
  roi: number | null; // フォーメーションを均等買いした場合の回収率(%)。オッズはスナップショット時点の参考値
  payoutYen: number | null; // 的中した場合の払戻金額（100円賭け1点あたり）。不的中・未確定はnull
}

export interface AccuracyStats {
  totalRaces: number;
  honmeiHitRate: number | null; // ◎の単勝的中率(%)
  honmeiTop3Rate: number | null; // ◎の複勝的中率(%)
  sanrentanHitRate: number | null; // 3連単フォーメーション的中率(%)
  overallRoi: number | null; // 全レース合算の回収率(%)
}

/** 1日分のサマリー（前日集計用）。AccuracyStatsに対象日と的中ベスト5を加えたもの。 */
export interface DailySummary extends AccuracyStats {
  statDate: string; // YYYYMMDD
  topPayouts: { race: RaceRow; combo: string; payoutYen: number }[]; // 配当が高い順、最大5件
}
