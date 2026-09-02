import type {
  BankInfoRow,
  BetSuggestion,
  EntryWithRacer,
  PositionWinRate,
  RaceScenario,
  RacerHistoryRow,
  ScoreBreakdown,
  ScoredEntry,
  ScoreWeights,
  VenueKimariteRates,
} from "./types";

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * ①ライン評価：ライン構成人数・隊列内の位置・地区の結びつきから算出する。
 * line_group/line_positionが無い（並び予想が未提供の）レースはニュートラル値を返す。
 *
 * 実績1000レース超のバックテストでは真の勝率が先頭18.0%＞番手13.8%＞3番手2.6%と
 * 出ており、一見この配点（先頭5点＜番手15点）は逆転しているように見える。
 * しかし実際に先頭優遇に変更してバックテストすると◎的中率・回収率とも悪化した
 * （脚質評価側の「逃×先頭」を優遇する調整と情報が重複し、同じ強さを二重に
 * 加点してしまうため）。脚質評価側（calculateKyakushitsuScore）で調整済みのため、
 * ここは意図的に据え置いている。
 */
export function calculateLineScore(
  entry: EntryWithRacer,
  allEntries: EntryWithRacer[]
): ScoreBreakdown {
  if (entry.line_group == null || entry.line_position == null) {
    return { score: 50, factors: { 理由: "ライン情報未提供のためニュートラル値" } };
  }

  const lineMates = allEntries.filter((e) => e.line_group === entry.line_group);
  const lineSize = lineMates.length;

  // scripts/diagnose-gear-linesize-pairing.tsで人数別の真の勝率を見ると
  // 単騎11.8%・2人15.9%・3人26.0%・4人以上42.3%と単調に伸び、3人と4人以上の
  // 差も大きい（75,278出走）。4人以上だけ基礎点を80→95に上げて試したが、
  // backtestでは◎的中率44.8%→44.3%と悪化した（10740→10791レース、+51件の
  // 差分はあるが方向は明確）。既に3人以上を一律80点で優遇しており、
  // 4人以上はレース自体が少ない（全体の2.4%）こともあって、そこをさらに
  // 積み増しても他の要素との兼ね合いで効果が出なかったとみられる。現状維持。
  const baseByLineSize = lineSize >= 3 ? 80 : lineSize === 2 ? 60 : 40;

  const positionBonus =
    entry.line_position === "先頭" ? 5 : entry.line_position === "番手" ? 15 : 10;

  // 同県ライン加点：scripts/diagnose-jimoto-line.tsの単体集計では同県ラインの方が
  // ワンツー率が低かった（12.2% vs 混成23.1%、3047本/21435本）ため撤去を試したが、
  // 実際にbacktestすると◎的中率が44.8%→44.6%とわずかに悪化した（同一10740レースの
  // クリーンな比較）。単体の相関と、既存スコアに混ぜた時の効果は別物という、
  // このプロジェクトで繰り返し確認しているパターン通りだったため、撤去せず現状維持する。
  const prefs = new Set(lineMates.map((e) => e.pref).filter(Boolean));
  const samePrefBonus = lineSize >= 2 && prefs.size === 1 ? 5 : 0;

  const score = clamp(baseByLineSize + positionBonus + samePrefBonus);

  return {
    score,
    factors: {
      ライン人数: lineSize,
      隊列位置: entry.line_position,
      同県ライン: samePrefBonus > 0 ? "あり" : "なし",
      基礎点: baseByLineSize,
      位置加点: positionBonus,
      同県加点: samePrefBonus,
    },
  };
}

// L1〜L3はガールズケイリン（女子）の級班。男子とは別の階級体系で、
// 男女が同じレースで走ることは無いため相対値のみ意味を持つ。
const CLASS_RANK_SCORES: Record<string, number> = {
  SS: 100,
  S1: 85,
  S2: 70,
  A1: 55,
  A2: 40,
  A3: 25,
  L1: 70,
  L2: 45,
  L3: 25,
};

// 数値が大きいほど上位級。昇級/降級の判定に使う（S級・A級の大まかな序列）。
const CLASS_RANK_ORDER: Record<string, number> = {
  SS: 6,
  S1: 5,
  S2: 4,
  A1: 3,
  A2: 2,
  A3: 1,
  L1: 3,
  L2: 2,
  L3: 1,
};

export type ClassChangeStatus = "昇級" | "降級" | "変動なし" | "不明";

export function determineClassChange(racer: {
  class_rank: string | null;
  prev_class_rank: string | null;
}): ClassChangeStatus {
  if (!racer.class_rank || !racer.prev_class_rank) return "不明";
  const cur = CLASS_RANK_ORDER[racer.class_rank];
  const prev = CLASS_RANK_ORDER[racer.prev_class_rank];
  if (cur == null || prev == null) return "不明";
  if (cur > prev) return "昇級";
  if (cur < prev) return "降級";
  return "変動なし";
}

/**
 * 競輪の級班替えは毎年1月・7月に行われる。切り替え直後は
 * 「今期級班での実績がまだ蓄積されていない」特殊期間として扱う
 * （降級直後は新しい級では相対的に格上＝狙い目、昇級直後は格上の相手と
 * 走るため苦戦しやすい、という定石を反映する）。
 * 1ヶ月目は影響が大きいとみて全量、2ヶ月目は影響が薄まるとみて半分の
 * 調整量を適用し、3ヶ月目以降は調整しない。
 */
export function classChangeAdjustmentFactor(kaisaiDate: string): number {
  const month = Number(kaisaiDate.slice(4, 6));
  // 1月=切替月、2月=1ヶ月後 / 7月=切替月、8月=1ヶ月後
  if (month === 1 || month === 7) return 1;
  if (month === 2 || month === 8) return 0.5;
  return 0;
}

/**
 * ②脚質・実力評価：級班・勝率・3着内率・脚質とライン内位置の相性・
 * 昇級/降級（切り替え直後1ヶ月のみ）から算出する。
 * ギア倍数は現状データ未取得のため考慮していない。
 */
export function calculateKyakushitsuScore(
  entry: EntryWithRacer,
  kaisaiDate: string,
  allEntries: EntryWithRacer[]
): ScoreBreakdown {
  const classRankScore = entry.class_rank
    ? CLASS_RANK_SCORES[entry.class_rank] ?? 50
    : 50;
  const winRateScore = entry.syouritu != null ? clamp(entry.syouritu) : 50;
  const placeRateScore = entry.rentairitu3 != null ? clamp(entry.rentairitu3) : 50;

  // 実績1000レース超のバックテスト集計（真の勝率、母数で正規化）による脚質別勝率は
  // 逃23.4% > 両15.6% > 追7.9%と大きく差があるが、旧実装は「逃×先頭」と「追×非先頭」を
  // 同じ100点（相性が良いという理由だけ）で評価しており、脚質そのものの強さの差を
  // 反映できていなかった。脚質自体の強さを土台にしつつ、隊列位置との相性で調整する。
  //
  // 旧実装は「先頭かどうか」の二値でしか隊列位置を見ておらず、番手と3番手を同列に
  // 扱っていた。しかしユーザー指摘（番手の選手は逃げ脚質だと番手まくりを出しやすい＝
  // 差しで溜めずに前に出る）を受けてscripts/diagnose-bantemakuri.ts/-2.tsで検証すると、
  // 隊列位置×脚質の実勝率は次のようにはっきり分かれていた（真の勝率、母数で正規化）：
  //   逃：先頭23.6%(2335) ≒ 番手23.4%(137) >> 3番手12.5%(8、母数少なく参考)
  //   両：番手19.1%(545) > 先頭16.1%(1417) >> 3番手4.3%(138)
  //   追：番手11.9%(2261) > 先頭5.4%(701) >> 3番手1.9%(1122)
  // 番手は「先頭より劣る位置」ではなく、追・両にとってはむしろ最も勝率が高い定位置
  // （差しで脚を溜められるため）であり、逃げにとっても先頭とほぼ互角（差しを待たず
  // 前に出て捲る＝番手まくりを打てるため）と分かった。一方3番手はどの脚質でも
  // 大きく勝率が落ちる。この3値の差を反映するようテーブルを番手/3番手で分離した。
  let fitScore = 50;
  if (entry.kyakushitsu === "逃") {
    fitScore = entry.line_position === "先頭" ? 95 : entry.line_position === "番手" ? 90 : 55;
  } else if (entry.kyakushitsu === "追") {
    fitScore = entry.line_position === "番手" ? 45 : entry.line_position === "先頭" ? 25 : 15;
  } else if (entry.kyakushitsu === "両") {
    fitScore = entry.line_position === "番手" ? 65 : entry.line_position === "先頭" ? 55 : 25;
  }

  // 先頭×番手の脚質ペア相性：ユーザー提案を受けてscripts/diagnose-gear-linesize-
  // pairing.tsで検証（75,278出走からライン単位に集計）。先頭が追込型で番手も
  // 追込型のライン（=誰も前に出る意志が無い組み合わせ）だけ、先頭勝率10.4%・
  // ワンツー率4.9%と他の組み合わせ（15〜25%台）から明確に外れて低かった
  // （n=789、他の組み合わせは概ねn=900〜12700）。この最悪ケースだけ追加減点する。
  const OI_SENKO_OI_BANTE_PENALTY = 10;
  if (entry.line_position === "先頭" && entry.kyakushitsu === "追") {
    const bantesu = allEntries.find(
      (e) => e.line_group === entry.line_group && e.line_position === "番手"
    );
    if (bantesu?.kyakushitsu === "追") {
      fitScore = clamp(fitScore - OI_SENKO_OI_BANTE_PENALTY);
    }
  }

  // 単騎の追込型への追加減点は不採用：scripts/diagnose-solo-kyakushitsu.tsの
  // 相関（単騎追込先頭の勝率3.8% vs 複数人ライン先頭10.2%、76,549出走）は
  // 明確だったが、実装してbacktest.tsで検証したところ◎的中率44.6%→44.2%
  // （n=10977、標準誤差約0.48ptなので誤差の範囲内）、本命回収率112.8%→113.8%と
  // 的中率・回収率で結果が割れ、有意な改善とは言えなかったため見送り。
  // 単独では強い相関でもスコアに混ぜると効果が消える／不明瞭になるという、
  // 地元ボーナスや同県ライン加点削除でも見られたのと同じパターン。

  const baseScore = clamp(
    classRankScore * 0.25 + winRateScore * 0.3 + placeRateScore * 0.25 + fitScore * 0.2
  );

  // 昇降級のスコア調整は行わない：「降級直後は新しい級で相対的に格上、昇級直後は
  // 格上の相手と走るため苦戦」という定石で+15/-10点の調整をしていたが、選手プロフィール
  // 補完後の7174出走の実績集計では降級12.9%・昇級13.7%とほぼ同水準（定石とは逆に
  // 昇級側がわずかに高いくらい）で、調整の根拠が無いことが分かった。実際に外した方が
  // ◎的中率42.7%→45.5%・複勝率72.3%→73.8%・3連複ボックス的中率35.5%→36.1%と改善した
  // （scripts/diagnose-classchange.ts、bank_infoと同様の手順で変更前後を比較して判断）。
  // 昇降級の判定・表示自体は参考情報として残す。
  const classChange = determineClassChange(entry);
  const adjustmentFactor = classChangeAdjustmentFactor(kaisaiDate);
  const classChangeAdjustment = 0; // 根拠なしと判明したため無効化（上のコメント参照）

  const score = clamp(baseScore + classChangeAdjustment);

  return {
    score,
    factors: {
      級班: entry.class_rank ?? "不明",
      前期級班: entry.prev_class_rank ?? "不明",
      昇降級: classChange,
      昇降級調整係数: adjustmentFactor,
      昇降級調整点: classChangeAdjustment,
      勝率: entry.syouritu ?? "不明",
      "3着内率": entry.rentairitu3 ?? "不明",
      脚質: entry.kyakushitsu ?? "不明",
      "脚質×隊列位置の相性": fitScore,
    },
  };
}

/**
 * バンクの決まり手傾向（逃げ/捲り/差しの1着割合）と選手の脚質の相性。
 * 逃→バンクの「逃げ」率、追→バンクの「差し」率、両→バンクの「捲り」率を
 * それぞれ大まかな適性指標として採用する（公式に「脚質×バンク相性」の
 * 統計が存在しないための近似）。
 *
 * データ源は venueKimarite（自前のresults実績、開催場ごとに算出）を優先し、
 * サンプル不足の開催場は bankInfo（KEIRIN.JPのjyoguideスクレイプ、静的値）に
 * フォールバックする。開催場別の決まり手割合は実際には大きくばらつく
 * （例：防府は逃57%、いわき平は差54%など）ため、この適性を反映できるかどうかで
 * バックテストの的中率・回収率に無視できない差が出る。
 */
function calculateBankFitScore(
  entry: EntryWithRacer,
  venueKimarite: VenueKimariteRates | null | undefined,
  bankInfo: BankInfoRow | undefined
): { score: number | null; usedPct: number | null } {
  const source = venueKimarite ?? bankInfo;
  if (!source || !entry.kyakushitsu) return { score: null, usedPct: null };
  const pct =
    entry.kyakushitsu === "逃"
      ? source.nige_pct
      : entry.kyakushitsu === "追"
        ? source.sashi_pct
        : source.makuri_pct;
  if (pct == null) return { score: null, usedPct: null };
  return { score: clamp(pct), usedPct: pct };
}

/**
 * 選手個人の決まり手適性：WINTICKET出走表の「1着・2着に入った際の勝ち方の回数」
 * （kimarite_nige_count等）から、脚質に対応する決まり手で実際に何割上位に
 * 入ってきたかを算出する。バンクの決まり手傾向（calculateBankFitScore）は
 * 開催場側の一般的な傾向だが、こちらは選手個人の実績に基づく適性指標。
 * KEIRIN.JP由来のレコード等でデータが無い場合はnullを返す（ニュートラル50点）。
 */
function calculatePersonalMoveFitScore(
  entry: EntryWithRacer
): { score: number | null; usedRate: number | null } {
  const { kimarite_nige_count, kimarite_makuri_count, kimarite_sashi_count, kimarite_mark_count } =
    entry;
  if (
    kimarite_nige_count == null ||
    kimarite_makuri_count == null ||
    kimarite_sashi_count == null ||
    kimarite_mark_count == null ||
    !entry.kyakushitsu
  ) {
    return { score: null, usedRate: null };
  }
  const total =
    kimarite_nige_count + kimarite_makuri_count + kimarite_sashi_count + kimarite_mark_count;
  if (total === 0) return { score: null, usedRate: null };

  const relevantCount =
    entry.kyakushitsu === "逃"
      ? kimarite_nige_count
      : entry.kyakushitsu === "追"
        ? kimarite_sashi_count
        : kimarite_makuri_count; // 両

  const rate = (relevantCount / total) * 100;
  return { score: clamp(rate), usedRate: rate };
}

/**
 * 新人期別ボーナス：ユーザーから「129期は強いので、得点が低くても優勢に」との
 * 指摘があり検証した。129期選手はA3級ルーキー同士のトーナメント（A級チ予選/
 * 準決/選抜/決勝、F2グレード）で42.5%の勝率（68/160走）を記録しており、同じ
 * レースに出た129期以外の選手の勝率8.7%を大きく上回る（母数778走）。
 * 決まり手回数・S/H/Bと違いheikin_tokuten（平均得点）とはほぼ無相関で
 * 重複しない新しい情報だった点が重要：129期の平均得点は74.18、同レース他選手は
 * 72.76とわずか1.4点差しかなく、得点最高選手が129期だったレースは
 * わずか10.7%（15/140）に留まる。つまり「得点はまだ低いが実力はそれ以上」
 * というユーザーの見立て通りで、既存スコアでは捉えられていない。
 * デビュー期をracers.debut_classとして持つ選手（現状129期のみ、
 * scraper/jik_kisokukai.pyで取り込み）に限定して適用する。
 *
 * classChangeAdjustmentFactor（昇級/降級調整）と同じく、加重平均の一項として
 * 混ぜるのではなく最終スコアへの「加点」として実装する。加重平均に混ぜる方式で
 * 最初に試したところ、対象外レース（全体の88%）でもotherScaleが常に薄まり
 * 無関係な選手のスコアまで歪めてしまい、◎的中率が悪化した（重み0.1で
 * 42.3%→42.0%、1184レース）。加点方式ならデータの無い91%超の出走には
 * 一切影響しない（+10点で42.3%→42.6%・回収率75.1%→80.2%と改善）。
 *
 * ユーザー指摘：「だんだん点数が高くなるから、デビューして3ヶ月の補正にして」。
 * レースを重ねてheikin_tokuten（平均得点）が実力に追いついてくると、この
 * ボーナスの根拠（得点はまだ低いが実力はそれ以上）が薄れていく。
 * classChangeAdjustmentFactorのデビュー直後1〜2ヶ月の減衰と同じ考え方で、
 * デビュー月を起点に3ヶ月かけて線形に減衰させ、4ヶ月目以降は0にする。
 * デビュー月は期ごとに手動で管理する（新しい期を追加したらROOKIE_DEBUT_YMにも
 * 追記すること）。公式のデビュー月（毎年5月）ではなく、実際にDBにレース記録が
 * 現れ始めた月を使う：129期は公式デビューが5月でもDB上の初出走は7月からで、
 * 月別勝率も7月49.5%→8月28.3%と推移していた。5月を起点にすると3ヶ月で
 * 8月には減衰しきってしまい、実際にはまだ基準値（7車立てで約14%）の
 * 2倍近く勝っている時期にボーナスが消えてbacktestが悪化した
 * （減衰+15点：◎的中率42.6%・回収率74.2% ＜ 減衰なし+15点：42.9%・79.9%）。
 * そのため起点はDB上の実際の初出走月に合わせている。
 *
 * さらにユーザーから「記録会のタイムを参考に予想して」との依頼があり、
 * kisokukai_grade（能力別評価S/A/B/C/D）別に実際の勝率との相関を診断した
 * （scripts/diagnose-kisokukai-grade.ts）。結果は非常に強い相関で、
 * S評価88.9%(16/18)・A評価37.1%(23/62)・B評価38.1%(16/42)・C評価28.1%(9/32)・
 * D評価18.8%(12/64)ときれいな階段状だった。そのため期一律のフラットな加点
 * ではなく、等級別に加点量を変えるKISOKUKAI_GRADE_BONUSに変更した
 * （S評価は母数18件とまだ小さいため、他等級より慎重な値にしている）。
 */
const KISOKUKAI_GRADE_BONUS: Record<string, number> = {
  S: 30,
  A: 15,
  B: 15,
  C: 8,
  D: 0,
};
const ROOKIE_DEBUT_YM: Record<string, string> = {
  "129期": "202607", // YYYYMM（DB上の初出走月。公式デビュー月の5月ではない）
  "130期": "202607", // 女子（130回生）もDB上は7月末が初出走
};

/**
 * 開催場コード(jocd)→都道府県。ユーザー提案「地元」の検証・加点に使う。
 * scripts/diagnose-jimoto-line.tsと同じマッピング（変更したら両方直すこと）。
 */
const JOCD_PREF: Record<string, string> = {
  "11": "北海道", "12": "青森", "13": "福島", "21": "新潟", "22": "群馬",
  "23": "茨城", "24": "栃木", "25": "埼玉", "26": "埼玉", "27": "東京",
  "28": "東京", "31": "千葉", "34": "神奈川", "35": "神奈川", "36": "神奈川",
  "37": "静岡", "38": "静岡", "42": "愛知", "43": "岐阜", "44": "岐阜",
  "45": "愛知", "46": "富山", "47": "三重", "48": "三重", "53": "奈良",
  "55": "和歌山", "56": "大阪", "61": "岡山", "62": "広島", "63": "山口",
  "73": "徳島", "74": "高知", "75": "愛媛", "81": "福岡", "83": "福岡",
  "84": "佐賀", "85": "長崎", "86": "大分", "87": "熊本",
};

/**
 * 地元選手への加点。scripts/diagnose-jimoto-line.tsで検証（74,782出走）：
 * 単体では地元選手の勝率19.3%(970/5031) vs 非地元13.9%(9726/69751)、
 * 複勝率も52.9% vs 42.1%と明確な差があった。entry.prefの「（地元）」
 * サフィックスは選手単位のracersテーブルが毎回上書きされる関係で必ずしも
 * 「このレース」の地元判定と一致しない（複数レースに出る選手の場合、
 * 直近スクレイプ時点の判定が残る）ため、判定はサフィックスに頼らず
 * entry.prefの基本府県（サフィックスを除いた値）と開催場の都道府県
 * （JOCD_PREF）を突き合わせる方式にした（過去データでも現在のスコアリング
 * でも同じロジックで判定でき、backtest.tsでの検証結果と本番の挙動が一致する）。
 *
 * ただし+8点で組み込んでbacktestすると、◎的中率44.8%→45.0%・本命回収率
 * 111.3%→112.0%とほぼ変化なし（データ件数が実行間で数十件ずれる誤差の
 * 範囲内）だった。このプロジェクトで繰り返し確認している「単体では強い
 * 信号でも、既存の重み付け平均スコアに混ぜると効果が消える」confound
 * パターンと同じ形（このケースでは、地元選手は必然的にその開催場での
 * 出走履歴が多くなりやすく、既存のcalculateSameConditionScore「同開催場
 * 平均着順」と重複している可能性が高い）。そのため無効化（0点）で残す。
 * 新人ボーナス等と違って加重平均ではなく加点方式なので、対象外の出走
 * （非地元）には一切影響しない。
 */
const JIMOTO_BONUS = 0;

function isJimoto(entry: EntryWithRacer, jocd: string): boolean {
  const venuePref = JOCD_PREF[jocd];
  if (!venuePref || !entry.pref) return false;
  const basePref = entry.pref.replace(/（地元）$/, "").trim();
  return basePref === venuePref;
}

function calculateJimotoBonus(entry: EntryWithRacer, jocd: string): number {
  return isJimoto(entry, jocd) ? JIMOTO_BONUS : 0;
}

function calculateRookieClassBonus(
  entry: EntryWithRacer,
  kaisaiDate: string
): { bonus: number; monthsSinceDebut: number | null } {
  const debutYm = entry.debut_class ? ROOKIE_DEBUT_YM[entry.debut_class] : undefined;
  if (!debutYm) return { bonus: 0, monthsSinceDebut: null };

  const baseBonus = entry.kisokukai_grade ? KISOKUKAI_GRADE_BONUS[entry.kisokukai_grade] ?? 0 : 0;
  if (baseBonus === 0) return { bonus: 0, monthsSinceDebut: null };

  const debutY = Number(debutYm.slice(0, 4));
  const debutM = Number(debutYm.slice(4, 6));
  const raceY = Number(kaisaiDate.slice(0, 4));
  const raceM = Number(kaisaiDate.slice(4, 6));
  const monthsSinceDebut = (raceY - debutY) * 12 + (raceM - debutM);
  if (monthsSinceDebut < 0) return { bonus: 0, monthsSinceDebut };

  const decayFactor = clamp(1 - monthsSinceDebut / 3, 0, 1);
  return { bonus: baseBonus * decayFactor, monthsSinceDebut };
}

const MONTH_DAY_RE = /^(\d{2})\/(\d{2})$/;

function monthDayToDayOfYear(md: string): number | null {
  const m = MONTH_DAY_RE.exec(md);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  if (month < 1 || month > 12) return null;
  return cumulative[month - 1] + day;
}

/**
 * 出走間隔：直近の出走日から今回のレース日までの日数を評価する。
 * 日付は年をまたぐ厳密な特定をしていない簡易実装のため、
 * 日数差は「年内の日付として最も近い側」を採用する近似値。
 */
function calculateIntervalScore(
  kaisaiDate: string,
  history: RacerHistoryRow[]
): { score: number | null; days: number | null } {
  if (history.length === 0) return { score: null, days: null };
  const raceMonth = Number(kaisaiDate.slice(4, 6));
  const raceDay = Number(kaisaiDate.slice(6, 8));
  const raceDoy = monthDayToDayOfYear(
    `${String(raceMonth).padStart(2, "0")}/${String(raceDay).padStart(2, "0")}`
  );
  if (raceDoy == null) return { score: null, days: null };

  let minDiff: number | null = null;
  for (const h of history) {
    const doy = monthDayToDayOfYear(h.race_date);
    if (doy == null) continue;
    let diff = raceDoy - doy;
    if (diff < 0) diff += 365; // 年跨ぎの近似
    if (diff >= 0 && (minDiff == null || diff < minDiff)) minDiff = diff;
  }
  if (minDiff == null) return { score: null, days: null };

  // 連闘(0-2日)はやや減点、7-21日を最良、長期休養(60日超)は減点
  let score: number;
  if (minDiff <= 2) score = 60;
  else if (minDiff <= 6) score = 80;
  else if (minDiff <= 21) score = 100;
  else if (minDiff <= 40) score = 75;
  else if (minDiff <= 60) score = 55;
  else score = 35;

  return { score, days: minDiff };
}

/**
 * 過去の同条件（同開催場）成績：venue_abbrに現在の開催場名の文字が
 * 含まれる履歴を抽出し、平均着順から算出する近似値。
 * venue_abbrは1文字略称のため厳密な一致ではない点に注意。
 */
function calculateSameConditionScore(
  keirinjoName: string,
  history: RacerHistoryRow[]
): { score: number | null; matchedRaces: number; avgFinish: number | null } {
  const nameChars = [...keirinjoName.replace("競輪場", "")];
  const matched = history.filter(
    (h) => h.venue_abbr && nameChars.some((c) => h.venue_abbr!.includes(c))
  );
  if (matched.length === 0) return { score: null, matchedRaces: 0, avgFinish: null };

  const positions: number[] = [];
  for (const h of matched) {
    for (const p of h.finish_positions.split(",")) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) positions.push(n);
    }
  }
  if (positions.length === 0) return { score: null, matchedRaces: matched.length, avgFinish: null };

  const avgFinish = positions.reduce((a, b) => a + b, 0) / positions.length;
  // 平均着順1着=100点、9着以降=0点程度の線形マッピング
  const score = clamp(100 - (avgFinish - 1) * 12.5);
  return { score, matchedRaces: matched.length, avgFinish };
}

const RECENT_FORM_EVENTS = 3; // 直近何"イベント"（1イベント=2〜4走ぶんのfinish_positions）を見るか

/**
 * 直近成績（開催場を問わない好調・不調の波）：scripts/diagnose-recent-form.tsで検証
 * （77,252出走）。直近3イベント（calculateIntervalScoreと同じ年跨ぎ簡易近似で選ぶ）の
 * finish_positionsを平均し、着順が良いほど高スコアにする。heikin_tokuten三分位で
 * 層別しても効果が消えない（上位選手の中でも直近好調29.0%・不調10.7%と約3倍差）
 * ことを確認済みで、既存の強さ指標（得点・連対率）とは別の情報を持つ。
 * calculateSameConditionScoreと同じ線形マッピングを使う。
 */
function calculateRecentFormScore(
  kaisaiDate: string,
  history: RacerHistoryRow[]
): { score: number | null; avgFinish: number | null; events: number } {
  const raceMonth = Number(kaisaiDate.slice(4, 6));
  const raceDay = Number(kaisaiDate.slice(6, 8));
  const raceDoy = monthDayToDayOfYear(
    `${String(raceMonth).padStart(2, "0")}/${String(raceDay).padStart(2, "0")}`
  );
  if (raceDoy == null) return { score: null, avgFinish: null, events: 0 };

  const withDiff = history
    .map((h) => {
      const doy = monthDayToDayOfYear(h.race_date);
      if (doy == null) return null;
      let diff = raceDoy - doy;
      if (diff <= 0) diff += 365; // 年跨ぎの近似（当日自身は除外するため<=0も繰り下げ）
      return { diff, h };
    })
    .filter((x): x is { diff: number; h: RacerHistoryRow } => x != null)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, RECENT_FORM_EVENTS);

  const positions: number[] = [];
  for (const { h } of withDiff) {
    for (const p of h.finish_positions.split(",")) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0) positions.push(n);
    }
  }
  if (positions.length === 0) return { score: null, avgFinish: null, events: withDiff.length };

  const avgFinish = positions.reduce((a, b) => a + b, 0) / positions.length;
  const score = clamp(100 - (avgFinish - 1) * 12.5);
  return { score, avgFinish, events: withDiff.length };
}

/**
 * 位置別勝率：entries.line_position × results.finish_pos の自前集計から、
 * 今回の隊列内位置と同じ位置での勝率を評価する。
 * 母数が少ないうちは極端な値（1走で100%等）になりやすいため、
 * 選手自身の通算勝率(syouritu)を事前分布としたベイズ的な縮小推定を行う。
 */
function calculatePositionWinRateScore(
  entry: EntryWithRacer,
  positionWinRates: PositionWinRate[]
): { score: number | null; races: number; rawRate: number | null } {
  if (!entry.line_position) return { score: null, races: 0, rawRate: null };
  const match = positionWinRates.find((p) => p.line_position === entry.line_position);
  if (!match || match.races === 0) return { score: null, races: 0, rawRate: null };

  const priorWeight = 3;
  const priorRate = (entry.syouritu ?? 15) / 100;
  const smoothedRate =
    (match.wins + priorWeight * priorRate) / (match.races + priorWeight);

  return { score: clamp(smoothedRate * 100), races: match.races, rawRate: match.winRate };
}

/**
 * バックストレッチ先頭通過実績（B）：WINTICKET出走表のback_lead_count
 * （最終周回バックストレッチ線を先頭通過した回数）を使い、そのレースの
 * 出走選手の中でBが何番目に高いかを見る指標。
 * 診断（scripts/diagnose-shb.ts、7994出走・結果確定分）で、レース内でのB順位別の
 * 真の勝率が 1位27.0%→2位20.7%→3位16.7%→4位14.2%→5位8.0%→6位6.7%→7位5.8%と
 * 極めて綺麗な単調減少を示した。生カウントのバケット別勝率も8.8%→14.1%→
 * 21.3%→23.3%→27.0%と単調増加しており、WINTICKET公式ヘルプの「ここでの位置が
 * ゴールでの着順に大きく影響することが多い」という説明と一致する強い信号。
 * 同様に集計したH（ホーム線）も近い傾向、S（好スタート）は弱くノイジーだった
 * ためBのみを採用する。8位以下は母数が少なく不安定なため7位の値で頭打ちにする。
 *
 * ただし総合スコアへの単純合成はバックテストで効果が無いと判明した
 * （1148レース、重み0:42.0%(482)→0.1:41.9%(481)→0.2:41.7%(479)、0.2は2回実行し
 * 完全再現。的中率が単調に悪化）。決まり手適性(personalMoveResult)の失敗と
 * 同じパターン：Bで先頭に立つ選手は結局heikin_tokuten/rentairitu2など既存の
 * 統計評価が既に高評価している選手と重なりが大きく、追加の重みは新しい情報を
 * 足すのではなく既にチューニング済みの他要素の重みを薄めるだけになったと考えられる。
 * このため現在は重み0＝合成に使わず、参考表示のみ（LEAD_POSITION_WEIGHT定数）。
 */
const BACK_LEAD_RANK_WIN_RATE = [27.0, 20.7, 16.7, 14.2, 8.0, 6.7, 5.8];

/** entryを含むフィールド内で、getterの値が高い順に何番目かを返す（値なしはnull）。 */
function rankWithinField(
  entry: EntryWithRacer,
  allEntries: EntryWithRacer[],
  getter: (e: EntryWithRacer) => number | null
): number | null {
  const withValue = allEntries.filter((e) => getter(e) != null);
  if (getter(entry) == null || withValue.length === 0) return null;

  const sorted = [...withValue].sort(
    (a, b) => (getter(b) as number) - (getter(a) as number) || a.car_num - b.car_num
  );
  const idx = sorted.findIndex((e) => e.entry_id === entry.entry_id);
  return idx === -1 ? null : idx + 1;
}

function calculateLeadPositionScore(
  entry: EntryWithRacer,
  allEntries: EntryWithRacer[]
): { score: number | null; rank: number | null } {
  const rank = rankWithinField(entry, allEntries, (e) => e.back_lead_count);
  if (rank == null) return { score: null, rank: null };

  const rate = BACK_LEAD_RANK_WIN_RATE[Math.min(rank, BACK_LEAD_RANK_WIN_RATE.length) - 1];
  return { score: clamp(rate), rank };
}

/**
 * スタート優位（車番×S=好スタート回数）：競輪の定説通り、車番（内枠）は
 * スタート優位で真の勝率にも大きな差があった（scripts/diagnose-carnum-start.ts、
 * 車番1:24.8%〜車番6:5.1%）。さらにS（standing_count、好スタート回数）の
 * レース内順位を掛け合わせた6区分では、内枠×S上位が20.9%で最良、
 * 中枠×S下位が10.0%で最低と、車番だけよりもさらに分離度が高い。
 *
 * 【重要な補足・検証済み】ユーザーの指摘で、ミッドナイト競輪（発走21〜23時台）は
 * 車番が得点順に割り当てられることが判明した（scripts/_check_midnight_races.tsで
 * 確認：21時台93.5%・22時台96.7%・23時台98.2%で「車番1=そのレース得点最高」）。
 * つまり「車番1が強い」信号の一部は、隊列上の真のスタート優位ではなく
 * 得点評価の言い換えに過ぎない。scripts/diagnose-carnum-midnight.tsで通常/
 * ミッドナイトを分けて再診断すると、通常レースは内_上位18.0%〜中_下位10.9%
 * （差7pt）、ミッドナイトは内_上位29.4%〜外_下位1.5%（差28pt）と分布が
 * 大きく異なることを確認した。
 *
 * この理解をもとに「ミッドナイト用に実測値を強めたテーブルを使う」「ミッドナイト
 * では本要素を使わずニュートラルにする」の2案を実装しbacktestで検証したが、
 * どちらも元の統合テーブルより悪化した（同一1184レースで比較：統合テーブル
 * 28.9%(342)/ROI75.1% ＞ 強化版28.5%(338)/ROI70.8% ＞ ニュートラル版28.1%(333)/
 * ROI69.7%）。原因の特定はできていないが、通常/ミッドナイトで分割すると
 * 各テーブルの母数が減り推定が不安定になる一方、統合テーブルは母数を保った
 * 分だけ安定した汎用的な heuristic として機能している可能性がある。
 * そのため車番=得点順という因果関係の理解自体は正しいが、実装は元の統合
 * テーブルのままにしている（理論的な正しさよりbacktestの実測を優先）。
 *
 * ◎選定用の総合スコアには使わず（決まり手回数・Bの教訓：強い信号でも合成すると
 * 既存の統計評価と重複して的中率が悪化するため）、2着・3着候補プールの並び替え
 * （lineupOrderScore）専用に限定して使う。
 */
const CAR_S_BUCKET_RATE: Record<string, number> = {
  "内_上位": 20.9,
  "内_下位": 16.4,
  "中_上位": 11.5,
  "中_下位": 10.0,
  "外_上位": 15.9,
  "外_下位": 10.2,
};

function carNumBucket(carNum: number): "内" | "中" | "外" {
  if (carNum <= 3) return "内";
  if (carNum <= 6) return "中";
  return "外";
}

function calculateStartPositionScore(
  entry: EntryWithRacer,
  allEntries: EntryWithRacer[]
): { score: number | null } {
  const sRank = rankWithinField(entry, allEntries, (e) => e.standing_count);
  if (sRank == null) return { score: null };

  const sBucket = sRank <= 3 ? "上位" : "下位";
  const rate = CAR_S_BUCKET_RATE[`${carNumBucket(entry.car_num)}_${sBucket}`];
  return { score: clamp(rate) };
}

/**
 * 選手個人のマーク率：kimarite_mark_count / (逃・捲・差・マの合計)。
 * ユーザー指摘「マークが多い選手はライン1・2着で決まりやすい（マーク選手は2着）」を
 * scripts/diagnose-markline.tsで検証：自分のラインが1-2着を占める決着の2着に限ると
 * 平均マーク率29.9%、それ以外の2着は23.0%、全1着は14.4%と、2着に回るタイプほど
 * マーク率が高い傾向は単独診断では出ていた。
 *
 * しかしlineupOrderScoreへ重み0.5で組み込みbacktest.tsで検証したところ、
 * 既にLINEUP_ORDER_WEIGHT=0.5で調整済みだったバランスを崩し、ほぼ全シナリオが
 * 悪化した（1275レース：まくり/差し一撃回収率105.5%→61.0%、全シナリオ合成
 * 的中率31.6%→28.2%・回収率87.8%→74.3%）。番手×差し優位ボーナス（下記
 * generateScenarios内）を0にしても大きくは戻らなかった（まくり回収率67.1%止まり）
 * ため、主因はこのマーク率の重みと判明。personalMoveFitScore・leadResult等と
 * 同じ「単独診断は綺麗でも既存の重み付き信号と衝突する」パターンのため、
 * 関数自体は残すが合成には使わない（現状どこからも呼ばれていない）。
 */
function calculateMarkRateScore(entry: EntryWithRacer): { score: number | null } {
  const { kimarite_nige_count, kimarite_makuri_count, kimarite_sashi_count, kimarite_mark_count } =
    entry;
  if (
    kimarite_nige_count == null ||
    kimarite_makuri_count == null ||
    kimarite_sashi_count == null ||
    kimarite_mark_count == null
  ) {
    return { score: null };
  }
  const total =
    kimarite_nige_count + kimarite_makuri_count + kimarite_sashi_count + kimarite_mark_count;
  if (total === 0) return { score: null };
  return { score: clamp((kimarite_mark_count / total) * 100) };
}

/**
 * 最終周回の隊列（並び）予想スコア：買い目提案画面の2着・3着候補プールの
 * 並び替えにのみ使う特別な合成値（◎選定の総合スコアtotalScoreとは別。
 * calculateStatsScoreへの合成は前述の通り効果が無いと判明したため行っていない）。
 * ◎の選定はtotalScoreのまま変更せず、「軸が決まった後、2・3着に来やすいのは
 * 誰か」という限定的な用途にだけスタート優位・バック先頭通過実績を使う。
 *
 * ◎軸の総合スコアに混ぜた場合（LEAD_POSITION_WEIGHT等）は既存の統計評価との
 * 重複で悪化したが、こちらは「軸が決まった後の2・3着の並び」という別の判断
 * ポイントに使うため重複しておらず、実際にbacktest.tsで改善を確認できた
 * （1148レース、weight0→0.5で全シナリオ合成的中率28.8%(331)→29.4%(337)・
 * 回収率72.1%→77.8%、まくり/差し一撃は回収率66.4%→93.8%と大きく改善。
 * 0.5は2回実行し完全再現。0.7→74.9%、1.0→71.9%とさらに重みを上げると
 * 悪化に転じたため0.5を採用）。マーク率(calculateMarkRateScore)も同じ枠組みで
 * 追加検証したが上記の通り悪化したため、MARK_RATE_WEIGHT=0で無効化（呼び出し自体は
 * 他の無効化済み要素と同じ形で残す）。
 */
const LINEUP_ORDER_WEIGHT = 0.5;
const MARK_RATE_WEIGHT = 0;

function lineupOrderScore(entry: ScoredEntry, allEntries: EntryWithRacer[]): number {
  const startScore = calculateStartPositionScore(entry.entry, allEntries).score ?? 50;
  const leadScore = calculateLeadPositionScore(entry.entry, allEntries).score ?? 50;
  const markScore = calculateMarkRateScore(entry.entry).score ?? 50;
  return (
    entry.totalScore +
    LINEUP_ORDER_WEIGHT * (startScore + leadScore - 100) +
    MARK_RATE_WEIGHT * (markScore - 50)
  );
}

/**
 * ③データ統計評価：バンク適性・出走間隔・過去の同条件成績・位置別勝率・
 * 連対率を重み付け合成する（選手個人の決まり手適性・バックストレッチ先頭通過
 * 実績は算出するがいずれもバックテストで効果が無いと判明したため現在は重み0＝
 * 合成に使わず、参考表示のみ）。
 *
 * オッズは予想の参考にしない方針のため意図的に対象外にしている
 * （群衆の人気を自分のスコアに混ぜると、群衆と同じ判断に収束してしまうため）。
 * 天候も事前予報が取得できないため対象外
 * （レース終了後の実績値としてracesテーブルには保存しているが、
 * 予想スコアには反映していない。過去レースの振り返り分析用）。
 * 各要素はデータが無い場合ニュートラル(50点)にフォールバックする。
 */
const LEAD_POSITION_WEIGHT = 0;
// backtest.ts検証中は0のまま（表示系の変更を先にデプロイするため）。
// 検証が済み次第、有効な重みに更新してこのコメントも更新する。
const RECENT_FORM_WEIGHT = 0; // scripts/diagnose-recent-form.tsの検証結果を受けて検証中（calculateRecentFormScoreのコメント参照）

export function calculateStatsScore(
  entry: EntryWithRacer,
  kaisaiDate: string,
  keirinjoName: string,
  jocd: string,
  bankInfo: BankInfoRow | undefined,
  history: RacerHistoryRow[],
  positionWinRates: PositionWinRate[],
  venueKimarite?: VenueKimariteRates | null,
  allEntries?: EntryWithRacer[]
): ScoreBreakdown {
  const bankResult = calculateBankFitScore(entry, venueKimarite, bankInfo);
  const intervalResult = calculateIntervalScore(kaisaiDate, history);
  const sameConditionResult = calculateSameConditionScore(keirinjoName, history);
  const recentFormResult = calculateRecentFormScore(kaisaiDate, history);
  const positionResult = calculatePositionWinRateScore(entry, positionWinRates);
  const personalMoveResult = calculatePersonalMoveFitScore(entry);
  const leadResult = calculateLeadPositionScore(entry, allEntries ?? [entry]);
  const rookieResult = calculateRookieClassBonus(entry, kaisaiDate);
  const jimotoBonus = calculateJimotoBonus(entry, jocd);
  const jimotoMatch = isJimoto(entry, jocd);
  const rentaiScore = entry.rentairitu2 != null ? clamp(entry.rentairitu2) : null;

  // 選手個人の決まり手適性(personalMoveResult)は重み0.1/0.2の両方で検証したが、
  // 重みを上げるほど◎的中率が単調に悪化した（重み0:42.3%→0.1:41.7%→0.2:40.5%、
  // 1086レース）。回収率側の改善に見えた部分もまくり/差し一撃（母数42件）中心で、
  // 重みで的中件数が変わらずROIだけ変動しており分散の範囲と判断した。
  // 総合スコアへの単純合成では効果が無いと判断し無効化（0）。データ自体
  // （kimarite_*_count）は選手の個性を捉えており、まくり/差し一撃・逃げ粘り込み
  // シナリオの軸候補選定など、より限定的な使い方であれば今後再検証の余地がある。
  //
  // バックストレッチ先頭通過実績(leadResult)も同様に重み0.1/0.2で検証したが
  // （1148レース、42.0%→41.9%→41.7%、0.2は2回実行し完全再現）、こちらも
  // 単調に悪化したため無効化（0）。詳細はcalculateLeadPositionScoreのコメント参照。
  //
  // 新人期別ボーナス(rookieResult)はclassChangeAdjustmentFactorと同じく、
  // 加重平均に混ぜず最終スコアへの加点として適用する（対象外レースを
  // 一切歪めないため）。calculateRookieClassBonusのコメント参照。
  const otherScale = 1 - LEAD_POSITION_WEIGHT;
  const baseScale = 1 - RECENT_FORM_WEIGHT; // 直近成績の重み分だけ既存項目を比例縮小する
  const score = clamp(
    ((bankResult.score ?? 50) * 0.2 +
      (intervalResult.score ?? 50) * 0.15 +
      (sameConditionResult.score ?? 50) * 0.2 +
      (positionResult.score ?? 50) * 0.2 +
      (rentaiScore ?? 50) * 0.25 +
      (personalMoveResult.score ?? 50) * 0) *
      baseScale * otherScale +
      (recentFormResult.score ?? 50) * RECENT_FORM_WEIGHT * otherScale +
      (leadResult.score ?? 50) * LEAD_POSITION_WEIGHT +
      rookieResult.bonus +
      jimotoBonus
  );

  return {
    score,
    factors: {
      バンク適性: bankResult.usedPct != null ? `${bankResult.usedPct}%` : "不明",
      出走間隔: intervalResult.days != null ? `${intervalResult.days}日` : "不明",
      同開催場平均着順: sameConditionResult.avgFinish?.toFixed(1) ?? "不明",
      同開催場該当数: sameConditionResult.matchedRaces,
      直近成績平均着順: recentFormResult.avgFinish != null
        ? `${recentFormResult.avgFinish.toFixed(1)}（${recentFormResult.events}イベント）`
        : "不明",
      位置別勝率: positionResult.rawRate != null
        ? `${positionResult.rawRate.toFixed(0)}%(${positionResult.races}走・縮小推定後${positionResult.score?.toFixed(0)})`
        : "不明",
      連対率: entry.rentairitu2 ?? "不明",
      決まり手適性: personalMoveResult.usedRate != null
        ? `${personalMoveResult.usedRate.toFixed(0)}%`
        : "不明",
      バック先頭通過順位: leadResult.rank != null ? `${leadResult.rank}番目(B=${entry.back_lead_count})` : "不明",
      新人期別: entry.debut_class
        ? `${entry.debut_class}（デビュー${rookieResult.monthsSinceDebut ?? "?"}ヶ月目・加点${rookieResult.bonus.toFixed(1)}）`
        : "不明",
      地元: jimotoMatch ? `地元選手（加点は現在無効化中、詳細はJIMOTO_BONUSのコメント参照）` : "該当なし",
      注記: "オッズは意図的に不使用。天候はレース終了後にしか取得できないため未反映",
    },
  };
}

const MARKS: ScoredEntry["mark"][] = ["◎", "○", "▲", "△", "×"];

export function scoreRace(
  entries: EntryWithRacer[],
  weights: ScoreWeights,
  kaisaiDate: string,
  keirinjoName: string,
  jocd: string,
  bankInfo: BankInfoRow | undefined,
  historyBySnum: Record<string, RacerHistoryRow[]>,
  positionWinRatesBySnum: Record<string, PositionWinRate[]>,
  venueKimarite?: VenueKimariteRates | null
): ScoredEntry[] {
  const scored = entries.map((entry) => {
    const lineScore = calculateLineScore(entry, entries);
    const kyakushitsuScore = calculateKyakushitsuScore(entry, kaisaiDate, entries);
    const statsScore = calculateStatsScore(
      entry,
      kaisaiDate,
      keirinjoName,
      jocd,
      bankInfo,
      historyBySnum[entry.snum] ?? [],
      positionWinRatesBySnum[entry.snum] ?? [],
      venueKimarite,
      entries
    );
    const totalScore =
      lineScore.score * weights.line +
      kyakushitsuScore.score * weights.kyakushitsu +
      statsScore.score * weights.stats;
    const recentFormAvg = calculateRecentFormScore(kaisaiDate, historyBySnum[entry.snum] ?? []).avgFinish;

    return { entry, lineScore, kyakushitsuScore, statsScore, totalScore, recentFormAvg };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  return scored.map((s, i) => ({
    ...s,
    mark: MARKS[Math.min(i, MARKS.length - 1)],
  }));
}

const SANRENTAN_MAX_POINTS = 20;

/**
 * 本命(1位)と対抗(2位)の総合スコア差の閾値。scripts/diagnose-confidence.tsで
 * バックテスト済み：10点差未満は単勝的中率37〜46%、10〜20点差で81.7%（104レース）、
 * 20点差以上で100%（8レース）と大きく跳ね上がる。
 * この値以上なら本命の買い目を絞ってよく、レース一覧の「高信頼度」バッジにも使う。
 */
export const HIGH_CONFIDENCE_MARGIN = 10;

/**
 * 本命と対抗のスコア差がこの値未満なら「拮抗している」とみなし、
 * 本命の買い目を1着・2着入れ替え可能なボックス形式（例: 1=2-3）にする。
 */
const LOW_MARGIN_THRESHOLD = 5;

/** まくり/差し一撃の軸候補選びで、番手×差し優位（決まり手回数ベース）の選手に
 * 与えるタイブレーク用の加点として検証したが、backtest.tsで効果を確認できなかった
 * ため0で無効化（詳細はgenerateScenarios内のコメント参照）。 */
const MAKURI_SASHI_DOMINANT_BONUS = 0;

/**
 * 軸（1着固定）と、あらかじめ優先順に並べた候補プールから
 * 「1頭軸流し」フォーメーションを生成する。2着・3着は同じプールを使う。
 * プールサイズMのとき点数は M×(M-1)（2着・3着に同じ車番は使えないため）。
 * maxPointsを超えない最大のMを自動選択する。
 */
function formationFromPool(axis: number, orderedPool: number[], maxPoints: number): string[] {
  if (orderedPool.length < 2) return [];

  let poolSize = 2;
  for (let m = 2; m <= orderedPool.length; m++) {
    if (m * (m - 1) > maxPoints) break;
    poolSize = m;
  }
  const candidates = orderedPool.slice(0, poolSize);

  const combos: string[] = [];
  for (const second of candidates) {
    for (const third of candidates) {
      if (second === third) continue;
      combos.push(`${axis}-${second}-${third}`);
    }
  }
  return combos;
}

/**
 * 軸候補2頭（1着・2着を入れ替え可能）と、3着候補プールから
 * 「2頭ボックス＋3着流し」フォーメーションを生成する（例: 1=2-3）。
 * 本命と対抗のスコアが拮抗していて1着・2着の順序を絞りきれない時に使う。
 * 点数は2×3着候補数。maxPointsを超えない最大の3着候補数を自動選択する。
 */
function formationBoxTop2(
  axis1: number,
  axis2: number,
  thirdPool: number[],
  maxPoints: number
): string[] {
  const candidates = thirdPool.filter((c) => c !== axis1 && c !== axis2);
  let poolSize = 0;
  for (let m = 1; m <= candidates.length; m++) {
    if (m * 2 > maxPoints) break;
    poolSize = m;
  }
  if (poolSize === 0) return [];
  const thirds = candidates.slice(0, poolSize);

  const combos: string[] = [];
  for (const third of thirds) {
    combos.push(`${axis1}-${axis2}-${third}`);
    combos.push(`${axis2}-${axis1}-${third}`);
  }
  return combos;
}

/**
 * 指定した軸（1着固定）と車番ランキングから、2着・3着の候補プール
 * （軸を除く総合スコア上位M頭）を使ったフォーメーションを生成する。
 * ライン等を考慮しない単純版で、predictionsテーブルの過去スナップショット
 * （車番と合計スコアのみ）から的中判定を再現する用途（lib/accuracy.ts）に使う。
 */
function generateSanrentanFormationForAxis(
  axis: number,
  ranked: number[],
  maxPoints: number = SANRENTAN_MAX_POINTS
): string[] {
  return formationFromPool(
    axis,
    ranked.filter((c) => c !== axis),
    maxPoints
  );
}

/** ◎（総合スコア1位）を軸にした標準フォーメーション。 */
function generateSanrentanFormation(
  ranked: number[],
  maxPoints: number = SANRENTAN_MAX_POINTS
): string[] {
  if (ranked.length < 3) return [];
  return generateSanrentanFormationForAxis(ranked[0], ranked, maxPoints);
}

/**
 * 3連単の組み合わせ一覧（例: ["1-3-6","1-3-7",...]）を、
 * 「軸-2着候補-3着候補」の桁連結表記（例: "1-37-123567"）に変換する。
 * 全組み合わせが単一の1着（軸）を共有していない場合（3連複ボックス等）はnullを返す。
 */
export function formatFormationNotation(combinations: string[]): string | null {
  if (combinations.length === 0) return null;

  const parsed = combinations.map((c) => c.split("-").map(Number));
  const axis = parsed[0][0];
  if (!parsed.every((p) => p[0] === axis)) return null;

  const seconds = new Set<number>();
  const thirds = new Set<number>();
  for (const [, second, third] of parsed) {
    seconds.add(second);
    thirds.add(third);
  }

  const sortedJoin = (s: Set<number>) => [...s].sort((a, b) => a - b).join("");
  return `${axis}-${sortedJoin(seconds)}-${sortedJoin(thirds)}`;
}

/**
 * レースの位置づけ（予選/準決勝/決勝等）をsyumoku文字列から判定する。
 * scripts/diagnose-stage-holdout.tsで検証（前半/後半のアウトオブサンプル）：
 * 予選は学習期間ROI96.5%→検証期間103.5%と一貫して他より弱く、決勝(127.2%→
 * 153.6%)・選抜特選(130.8%→126.9%)・一般(127.1%→120.6%)は一貫して強かった
 * （開催場フィルタで過学習だった9th findingと違い、傾向が検証期間でも
 * 再現している）。scripts/daily-picks.tsで予選レースを厳選対象から除外する
 * のに使う。
 */
export function raceStage(syumoku: string | null): string {
  if (!syumoku) return "不明";
  if (/決勝/.test(syumoku) && !/準々|準決/.test(syumoku)) return "決勝";
  if (/準決勝/.test(syumoku)) return "準決勝";
  if (/準々決勝/.test(syumoku)) return "準々決勝";
  if (/選抜|特選/.test(syumoku)) return "選抜・特選";
  if (/予選/.test(syumoku)) return "予選";
  if (/一般/.test(syumoku)) return "一般";
  return "その他";
}

/**
 * 総合スコア順（降順）の車番配列から3連単フォーメーション・3連複ボックスを生成する。
 * predictionsテーブルに保存済みの過去の予想（車番と合計スコアのみ）からも
 * 同じロジックで再現できるよう、ScoredEntryではなく車番配列を受け取る形にしている。
 */
export function generateBetSuggestionsFromRanking(ranked: number[]): BetSuggestion[] {
  if (ranked.length < 3) return [];

  const formation = generateSanrentanFormation(ranked);

  const boxCars = ranked.slice(0, 4);
  const box = new Set<string>();
  for (let i = 0; i < boxCars.length; i++) {
    for (let j = i + 1; j < boxCars.length; j++) {
      for (let k = j + 1; k < boxCars.length; k++) {
        const combo = [boxCars[i], boxCars[j], boxCars[k]].sort((a, b) => a - b);
        box.add(combo.join("-"));
      }
    }
  }

  return [
    { betType: "3連単フォーメーション", combinations: formation },
    { betType: "3連複ボックス", combinations: [...box] },
  ];
}

export function generateBetSuggestions(scored: ScoredEntry[]): BetSuggestion[] {
  return generateBetSuggestionsFromRanking(scored.map((s) => s.entry.car_num));
}

/**
 * シナリオの2着・3着候補プールを「優先ライン」のメンバーを先頭に、
 * それ以外はlineupOrderScore（総合スコア＋隊列予想の加点）順で並べて返す
 * （軸自身は除く）。優先ラインは展開ごとに意味が異なる：
 * - 本命／逃げ粘り込み：軸と同じライン（先頭が残れば道連れで番手・3番手も上位に来やすい）
 * - まくり/差し一撃：軸に差される側＝本命ライン（差した後ろに残るのは元々前にいた選手たち）
 */
function buildLineAwarePool(
  axisCarNum: number,
  priorityLineGroup: number | null,
  allScored: ScoredEntry[]
): number[] {
  const allEntries = allScored.map((s) => s.entry);
  const others = allScored.filter((s) => s.entry.car_num !== axisCarNum);
  const byOrderDesc = (a: ScoredEntry, b: ScoredEntry) =>
    lineupOrderScore(b, allEntries) - lineupOrderScore(a, allEntries);

  const priority = others
    .filter((s) => priorityLineGroup != null && s.entry.line_group === priorityLineGroup)
    .sort(byOrderDesc);
  const rest = others
    .filter((s) => !(priorityLineGroup != null && s.entry.line_group === priorityLineGroup))
    .sort(byOrderDesc);

  return [...priority, ...rest].map((s) => s.entry.car_num);
}

/**
 * 総合スコア最上位を機械的に軸にするだけでなく、レースの決着展開が
 * 複数ありうることを踏まえて2〜3パターンの軸候補を提示する。
 * 2着・3着候補は「総合上位」ではなく展開・ラインから絞り込み、
 * 全パターン合計で3連単の買い目が20点以内に収まるよう配分する。
 *
 * - 本命: 総合スコア1位がそのまま押し切る想定。2・3着は同じラインの仲間を優先
 * - 逃げ粘り込み: ライン先頭の選手が単独で粘り切る想定。2・3着は道連れになりやすい
 *   同じラインの番手・3番手を優先
 * - まくり/差し一撃: 先頭ではない位置で追い込み型（脚質が追・両）の選手が
 *   自分の前を行く同ラインの先頭を差す想定。2・3着は軸自身のライン（差した後に
 *   自分の前にいた先頭が粘って2着に残りやすい＝実績53.2%）を優先
 *   （バンクの捲り決まり手率が高いほど根拠として言及する）
 *
 * 同じ選手が複数パターンの軸に重複する場合はその後のパターンをスキップし、
 * 実質的に異なる決着筋だけを2パターン以上出すようにしている。
 */
/** 選手にL級（ガールズケイリン）が1人でもいればガールズレースと判定する。 */
function isGirlsRace(scored: ScoredEntry[]): boolean {
  return scored.some((s) => s.entry.class_rank?.startsWith("L"));
}

/**
 * ガールズケイリンはライン（隊列の連携・番手/3番手）が無く、全選手が単騎
 * （1人1ライン、常に「先頭」表記）で走る。ユーザー指摘の通り、男子向け4パターン
 * （本命/逃げ粘り込み/まくり・差し一撃/単騎一撃）はライン前提の絞り込みロジック
 * （buildLineAwarePool、まくり/差し一撃の`line_position !== "先頭"`条件等）と
 * かみ合わず、まくり/差し一撃の候補が常に0件になるなど不自然な結果になる。
 * そのためガールズレースはラインを考慮せず、総合スコア順に軸を選ぶ
 * シンプルな2パターン（本命＝1位、対抗＝2位）だけを出す。
 */
function generateGirlsScenarios(scored: ScoredEntry[]): RaceScenario[] {
  const budget = Math.floor(SANRENTAN_MAX_POINTS / Math.min(2, scored.length));

  const buildFor = (axisIdx: number, label: string): RaceScenario => {
    const axis = scored[axisIdx];
    const pool = [...scored]
      .filter((s) => s.entry.car_num !== axis.entry.car_num)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((s) => s.entry.car_num);
    return {
      label,
      axisCarNum: axis.entry.car_num,
      axisName: axis.entry.name,
      reason: `ガールズケイリンはラインが無いため、総合スコア${axisIdx + 1}位を軸に採用（${axis.entry.class_rank ?? "-"}級）。2・3着候補も総合スコア順。`,
      formation: {
        betType: "3連単フォーメーション",
        combinations: formationFromPool(axis.entry.car_num, pool, budget),
      },
      likelyRank: axisIdx + 1,
    };
  };

  const scenarios = [buildFor(0, "本命")];
  if (scored.length >= 2) scenarios.push(buildFor(1, "対抗"));
  return scenarios;
}

export function generateScenarios(
  scored: ScoredEntry[],
  bankInfo: BankInfoRow | VenueKimariteRates | undefined | null
): RaceScenario[] {
  if (scored.length < 3) return [];
  if (isGirlsRace(scored)) return generateGirlsScenarios(scored);

  const usedAxes = new Set<number>();
  type ScenarioSpec = {
    label: string;
    axis: ScoredEntry;
    reason: string;
    priorityLineGroup: number | null;
  };
  const specs: ScenarioSpec[] = [];

  // ① 本命：総合スコア1位。同じラインの仲間が続きやすい
  const honmei = scored[0];
  usedAxes.add(honmei.entry.car_num);
  specs.push({
    label: "本命",
    axis: honmei,
    reason: `総合スコア1位。${honmei.entry.class_rank ?? ""}・${honmei.entry.kyakushitsu ?? "-"}${
      honmei.entry.line_position ? `（${honmei.entry.line_position}）` : ""
    }で総合力が最も高い。`,
    priorityLineGroup: honmei.entry.line_group,
  });

  // ② 逃げ粘り込み：ライン先頭の選手がそのまま独走で粘る想定。同じラインが道連れになりやすい
  const leadCandidate = [...scored]
    .filter((s) => s.entry.line_position === "先頭" && !usedAxes.has(s.entry.car_num))
    .sort((a, b) => b.totalScore - a.totalScore)[0];
  if (leadCandidate) {
    usedAxes.add(leadCandidate.entry.car_num);
    specs.push({
      label: "逃げ粘り込み",
      axis: leadCandidate,
      reason: `ライン先頭（${leadCandidate.entry.kyakushitsu ?? "-"}）。番手・3番手に守られて主導権を握りやすく、そのまま逃げ切る展開を想定。`,
      priorityLineGroup: leadCandidate.entry.line_group,
    });
  }

  // ③ まくり/差し一撃：先頭以外で追い込み適性（脚質が追・両）が高い選手が外から差す想定。
  //    1000レース超のバックテストで「番手が1着だった時、2着は同ラインの先頭
  //    （自分の前を走っていた選手がそのまま粘る）」が53.2%と最多だったため、
  //    差された側（honmeiのライン）ではなく軸自身のラインを優先する
  //
  //    ユーザー指摘「番手で、マークより差しが多い選手は先頭を差して1着になることが
  //    多い」をscripts/diagnose-markline.tsで検証：番手選手を決まり手回数で
  //    差し優位（kimarite_sashi_count > kimarite_mark_count）とマーク優位に分けると、
  //    差し優位は番手のまま1着になる率17.1%・自ラインの先頭より上位でゴールする率
  //    54.3%（マーク優位は9.2%・41.6%）と単独診断では大きく差があった。
  //    軸候補選びのタイブレーク加点として試したが、backtest.ts(1275レース)で
  //    まくり/差し一撃の回収率が105.5%→61.0%と大きく悪化（同時に検証した
  //    lineupOrderScoreのマーク率重みが主因と判明したが、本加点だけ0にしても
  //    67.1%までしか戻らず、単独でも上振れなかった）。MAKURI_SASHI_DOMINANT_BONUS=0
  //    で無効化して残す。
  const sashiDominantBonus = (s: ScoredEntry) => {
    const { kimarite_sashi_count, kimarite_mark_count } = s.entry;
    const sashiDominant =
      kimarite_sashi_count != null &&
      kimarite_mark_count != null &&
      kimarite_sashi_count > kimarite_mark_count;
    return s.entry.line_position === "番手" && sashiDominant ? MAKURI_SASHI_DOMINANT_BONUS : 0;
  };
  const makuriCandidate = [...scored]
    .filter(
      (s) =>
        !usedAxes.has(s.entry.car_num) &&
        s.entry.line_position !== "先頭" &&
        (s.entry.kyakushitsu === "追" || s.entry.kyakushitsu === "両")
    )
    .sort((a, b) => b.totalScore + sashiDominantBonus(b) - (a.totalScore + sashiDominantBonus(a)))[0];
  if (makuriCandidate) {
    usedAxes.add(makuriCandidate.entry.car_num);
    const bankNote =
      bankInfo?.makuri_pct != null
        ? `このバンクは捲り決着が${bankInfo.makuri_pct}%と出やすく、`
        : "";
    specs.push({
      label: "まくり/差し一撃",
      axis: makuriCandidate,
      reason: `${bankNote}${makuriCandidate.entry.line_position ?? "単騎"}から${
        makuriCandidate.entry.kyakushitsu
      }脚質を活かして外を一気に差す展開を想定。`,
      priorityLineGroup: makuriCandidate.entry.line_group,
    });
  }

  // ④ 単騎一撃：ライン人数1（単騎）の選手は隊列上不利になりやすくライン評価が
  //   低く出るが、個人の実力（脚質実力・データ統計）が高ければ距離や間隔に関わらず
  //   単独でも上位に飛び込んでくることがある。ライン評価を除いた個人力で選ぶ
  const soloCandidate = [...scored]
    .filter((s) => {
      if (usedAxes.has(s.entry.car_num) || s.entry.line_group == null) return false;
      const lineSize = scored.filter((o) => o.entry.line_group === s.entry.line_group).length;
      return lineSize === 1;
    })
    .sort(
      (a, b) =>
        b.kyakushitsuScore.score + b.statsScore.score - (a.kyakushitsuScore.score + a.statsScore.score)
    )[0];
  if (soloCandidate) {
    usedAxes.add(soloCandidate.entry.car_num);
    specs.push({
      label: "単騎一撃",
      axis: soloCandidate,
      reason: `単騎（ラインの後ろ盾なし）で隊列上は不利だが、${soloCandidate.entry.class_rank ?? ""}・勝率${
        soloCandidate.entry.syouritu ?? "不明"
      }％と個人力は高く、展開次第で単独でも上位に飛び込む可能性がある。`,
      priorityLineGroup: null,
    });
  }

  // 本命(1位)と対抗(2位)のスコア差。後段の本命専用調整だけでなく、
  // 他シナリオの点数配分にも使うためここで先に計算しておく。
  const taikou = scored[1];
  const margin = taikou ? honmei.totalScore - taikou.totalScore : Infinity;

  // 3連単の買い目は全パターン合計で20点以内に収める（1パターンあたりに均等配分）。
  // ただしmargin >= HIGH_CONFIDENCE_MARGIN（本命が抜けていて単勝的中率81.7%以上の
  // 実績があるレース）では、本命以外のシナリオが実際に当たる確率も相対的に下がる。
  // ユーザー指摘「単勝80%なのに他の買い目が多いのはおかしい」の通り、絞らずに
  // 均等配分したままだと的中率の低い代替シナリオに点数を割きすぎ、回収率を
  // 押し下げてしまうため、本命以外のシナリオの点数を絞る。
  const ALT_SCENARIO_HIGH_CONFIDENCE_BUDGET = 2;
  const perScenarioBudget = Math.floor(SANRENTAN_MAX_POINTS / specs.length);
  const altScenarioBudget =
    margin >= HIGH_CONFIDENCE_MARGIN
      ? Math.min(perScenarioBudget, ALT_SCENARIO_HIGH_CONFIDENCE_BUDGET)
      : perScenarioBudget;

  // このレースでどの展開が有力かの順位（1が最有力）。各シナリオの軸選手の
  // 総合スコアを比較する。本命の軸は定義上スコア最高だが、他の展開（逃げ粘り込み
  // ・まくり/差し一撃・単騎一撃）の軸がどれだけ本命に肉薄しているかを見ることで、
  // 「本命が抜けているレース」か「拮抗していて他の決着もありうるレース」かを
  // 相対的に判定できる。表示順（本命→逃げ粘り込み→…）は変えず、順位だけ付与する。
  const rankedByScore = [...specs].sort((a, b) => b.axis.totalScore - a.axis.totalScore);
  const likelyRankByCarNum = new Map(
    rankedByScore.map((spec, i) => [spec.axis.entry.car_num, i + 1])
  );

  const result = specs.map((spec) => {
    const pool = buildLineAwarePool(spec.axis.entry.car_num, spec.priorityLineGroup, scored);
    const budget = spec.label === "本命" ? perScenarioBudget : altScenarioBudget;
    return {
      label: spec.label,
      axisCarNum: spec.axis.entry.car_num,
      axisName: spec.axis.entry.name,
      reason:
        spec.label !== "本命" && margin >= HIGH_CONFIDENCE_MARGIN
          ? `${spec.reason} 本命が抜けているレースのため、こちらの買い目は保険的に絞っています。`
          : spec.reason,
      formation: {
        betType: "3連単フォーメーション" as const,
        combinations: formationFromPool(spec.axis.entry.car_num, pool, budget),
      },
      likelyRank: likelyRankByCarNum.get(spec.axis.entry.car_num)!,
    };
  });

  // 本命(1位)と対抗(2位)のスコア差に応じて、本命の買い目だけ調整する。
  const honmeiScenario = result.find((s) => s.label === "本命");
  if (taikou && honmeiScenario) {
    if (margin >= HIGH_CONFIDENCE_MARGIN) {
      // 本命が抜けているレース：軸の勝率は82.7%と高いが、2着・3着まで含めた
      // 3連単の的中率・回収率は軸の信頼度とは別物。旧実装は「軸が堅いなら買い目も
      // 絞れる」という考えで2点に絞っていたが、scripts/diagnose-hc-formation-size.ts
      // で高信頼度レース(307件)に絞って点数別のROIを検証すると、2点(現行)は
      // 的中率25.1%・回収率87.6%(赤字)なのに対し、20点まで広げると的中率76.9%・
      // 回収率152.3%(黒字)と、点数を増やすほど明確に的中率・回収率とも改善した
      // （6点90.4%/45.3%、12点84.8%/61.9%、いずれも20点に劣る）。
      // 軸が堅いことは「軸以外の着順も読める」ことを意味しない
      // （むしろ本命が抜けている分、2-3着争いは横並びになりやすいと考えられる）ため、
      // 絞るのではなく他シナリオ同様の上限20点まで広げる。
      const pool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored);
      honmeiScenario.formation = {
        betType: "3連単フォーメーション",
        combinations: formationFromPool(honmei.entry.car_num, pool, SANRENTAN_MAX_POINTS),
      };
      honmeiScenario.reason += ` 対抗との差が${margin.toFixed(1)}点あり単勝的中率が高い傾向です（軸の勝率82.7%実績）。ただし2・3着まで含めると絞り込みは難しいため、買い目は広めに取っています。`;
    } else if (margin < LOW_MARGIN_THRESHOLD) {
      // 本命・対抗が拮抗：1着・2着を入れ替え可能なボックス買いにする（例: 1=2-3）
      const thirdPool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored).filter(
        (c) => c !== taikou.entry.car_num
      );
      honmeiScenario.formation = {
        betType: "3連単フォーメーション",
        combinations: formationBoxTop2(
          honmei.entry.car_num,
          taikou.entry.car_num,
          thirdPool,
          perScenarioBudget
        ),
      };
      honmeiScenario.reason += ` 対抗とのスコア差が${margin.toFixed(1)}点と拮抗しているため、1着・2着を入れ替え可能な買い方にしています。`;
    } else {
      // 中間帯（LOW_MARGIN_THRESHOLD<=margin<HIGH_CONFIDENCE_MARGIN）：
      // 旧実装は2点固定だった。当時（793件）は点数を増やすほど一貫して悪化する
      // 結果だったが、データが10,525件規模まで増えた後にscripts/
      // diagnose-midband-formation-size.tsを再実行すると傾向が変わり、
      // この帯（578件）では
      //   2点: 的中率18.2%・回収率101.6%
      //   6点: 的中率33.9%・回収率133.6%（最良）
      //   12点: 的中率46.9%・回収率103.7%
      //   20点: 的中率56.7%・回収率102.5%
      // と6点がはっきり最良になった。母数が小さいうちの結論が、データが
      // 増えて安定したことで変わった例（ユーザー指摘「2点のところは
      // 増えてもいい」が的中）。6点に広げる。
      const pool = buildLineAwarePool(honmei.entry.car_num, honmei.entry.line_group, scored);
      honmeiScenario.formation = {
        betType: "3連単フォーメーション",
        combinations: formationFromPool(honmei.entry.car_num, pool, 6),
      };
    }
  }

  return result;
}
