-- 競輪予想アプリ DBスキーマ（SQLite）

CREATE TABLE IF NOT EXISTS races (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kaisai_date   TEXT NOT NULL,          -- 開催日 YYYYMMDD
    jocd          TEXT NOT NULL,          -- 開催場コード
    keirinjo_name TEXT NOT NULL,          -- 開催場名
    race_no       INTEGER NOT NULL,       -- レース番号
    syumoku       TEXT,                   -- 種目・クラス（例: Ａ級予選）
    grade_kbn     TEXT,                   -- グレード区分
    kyori         INTEGER,                -- 距離(m)
    shukai        INTEGER,                -- 周回数
    start_time    TEXT,                   -- 発走時刻
    encp          TEXT,                   -- サイト側のレース識別トークン（再取得用）
    tenki         TEXT,                   -- 天候（レース終了後のみ取得可能。実績値であり事前予報ではない）
    husoku        REAL,                   -- 不足（風速等、レース結果パネルの値をそのまま保持）
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kaisai_date, jocd, race_no)
);

-- 開催場（バンク）の特性データ。開催場単位でほぼ不変のため races とは別テーブルで管理する。
CREATE TABLE IF NOT EXISTS bank_info (
    jocd            TEXT PRIMARY KEY,      -- 開催場コード
    keirinjo_name   TEXT,
    shuutyou        INTEGER,               -- 周長(m) ※バンク図の画像ファイル名から推測
    tyokusen        TEXT,                  -- みなし直線距離
    kant            TEXT,                  -- センター部路面傾斜
    tkant           TEXT,                  -- 直線部分路面傾斜
    home_hukuin     TEXT,                  -- ホーム幅員
    back_hukuin     TEXT,                  -- バック幅員
    center_hukuin   TEXT,                  -- センター幅員
    nige_pct        REAL,                  -- このバンクでの1着決まり手「逃げ」割合(%)
    makuri_pct      REAL,                  -- 同「捲り」割合(%)
    sashi_pct       REAL,                  -- 同「差し」割合(%)
    feature_text    TEXT,                  -- サイト掲載の「バンク特徴」解説文
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 選手ごとの直近レース履歴（出走間隔・過去の同条件成績の算出に使う）。
-- 選手プロフィールページの「最近の成績」（直近8走）から取得する簡易版。
CREATE TABLE IF NOT EXISTS racer_race_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    snum              TEXT NOT NULL REFERENCES racers(snum),
    race_date         TEXT NOT NULL,        -- MM/DD（選手プロフィールページの表示そのまま、年情報なし）
    race_date_full    TEXT,                 -- YYYYMMDD。race_dateを取得時点基準で年を解決した値
                                             -- （keirin_scraper.pyのresolve_full_date参照）。
                                             -- バックテストで「そのレースより後の成績」を誤って
                                             -- 参照しないための日付フィルタに使う。
    venue_abbr        TEXT,                 -- 開催場の略称（例: "豊"）＋グレード（例: "Ｆ２"）
    finish_positions  TEXT,                 -- その開催内の各レース着順をカンマ区切りで（例: "6,5,5"）
    scraped_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (snum, race_date, venue_abbr)
);

CREATE TABLE IF NOT EXISTS racers (
    snum           TEXT PRIMARY KEY,      -- 選手登録番号
    name           TEXT NOT NULL,         -- 氏名
    pref           TEXT,                  -- 府県
    class_rank     TEXT,                  -- 級班（今期）（SS/S1/S2/A1...）
    prev_class_rank TEXT,                 -- 級班（前期）。class_rankと異なれば昇級/降級
    kyakushitsu    TEXT,                  -- 脚質（逃・両・追）
    gear_ratio     REAL,                  -- ギア倍数
    heikin_tokuten REAL,                  -- 平均得点
    syouritu       REAL,                  -- 勝率(%)
    rentairitu2    REAL,                  -- 2連対率(%)
    rentairitu3    REAL,                  -- 3着内率(%)
    -- 以下4つはWINTICKET出走表由来。「1着・2着に入った際の勝ち方の回数」
    -- （WINTICKET公式ヘルプの説明文そのまま。個人の得意な決まり手を表す）。
    -- KEIRIN.JP由来のレコードにはこの列は無くNULLのまま。
    kimarite_nige_count    INTEGER,       -- 逃げで1-2着になった回数
    kimarite_makuri_count  INTEGER,       -- 捲りで1-2着になった回数
    kimarite_sashi_count   INTEGER,       -- 差しで1-2着になった回数
    kimarite_mark_count    INTEGER,       -- マークで1-2着になった回数
    -- 以下3つもWINTICKET出走表由来（S/H/B列）。WINTICKET公式ヘルプの説明文：
    -- S=「スタートの号砲がなった後速やかに発走し、先頭誘導員の後方に付けた回数」
    -- H=「ゴールまで残り一周のホーム線を先頭で通過した回数」（ホーム線=ゴール線でもある）
    -- B=「最終バックストレッチラインを先頭で通過した回数。ここでの位置がゴールでの
    --    着順に大きく影響することが多い」（WINTICKET側の説明文をそのまま採用）
    standing_count INTEGER,               -- 好スタート回数
    home_lead_count INTEGER,              -- 最終周回ホーム線を先頭通過した回数
    back_lead_count INTEGER,              -- 最終周回バック線を先頭通過した回数
    -- 以下8つは日本競輪選手養成所（JIK）のデビュー前「記録会」データ
    -- （scraper/jik_kisokukai.py、PDFから取得）。新人選手はレース実績が無い/少なく
    -- 通常のスコアリングがほぼ機能しないため、代わりの実力参考指標として保持する。
    -- タイムは秒に統一（例: 11″20→11.20、1′09″21→69.21）。200m/400mは男女共通、
    -- 3・4種目目は男子1000m/3000m、女子500m/2000mと距離が異なる。
    debut_class      TEXT,                 -- 期（例: "129期"）
    tt200_sec        REAL,                 -- 200mタイムトライアル(秒)
    tt400_sec        REAL,                 -- 400mタイムトライアル(秒)
    tt500_sec        REAL,                 -- 500mタイムトライアル(秒、女子のみ)
    tt1000_sec       REAL,                 -- 1000mタイムトライアル(秒、男子のみ)
    tt2000_sec       REAL,                 -- 2000mタイムトライアル(秒、女子のみ)
    tt3000_sec       REAL,                 -- 3000mタイムトライアル(秒、男子のみ)
    kisokukai_grade  TEXT,                 -- 能力別総合評価（S/A/B/C/D）
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('score_weight_line', '0.35');
INSERT OR IGNORE INTO settings (key, value) VALUES ('score_weight_kyakushitsu', '0.35');
INSERT OR IGNORE INTO settings (key, value) VALUES ('score_weight_stats', '0.30');

CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    snum          TEXT NOT NULL REFERENCES racers(snum),
    car_num       INTEGER NOT NULL,       -- 車番
    line_group    INTEGER,                -- ラインのグループ番号
    line_position TEXT,                   -- 先頭・番手・3番手など
    pref          TEXT,                   -- 府県（このレースの開催場が地元の場合
                                           -- 「東京（地元）」のように末尾に付与される。
                                           -- racersテーブルのprefは選手単位で毎回上書き
                                           -- されレース単位の地元判定に使えないため、
                                           -- こちらはレース出走のたびに保存する）。
    pre_race_comment TEXT,                -- WINTICKET出走表「コメント」列。選手本人の
                                           -- 直前の一言（例:「自力。」「◯◯君。」で
                                           -- マーク相手を名指しすることもある）。
                                           -- レースごとに変わるためentries側で持つ。
    gear_ratio    REAL,                   -- WINTICKET出走表「ギヤ倍率」列。racers.gear_ratio
                                           -- は現状どのスクレイパーからも書き込まれておらず
                                           -- 常にNULL（未使用カラム）。ギア比は同一選手でも
                                           -- レースごとに変わりうる（同日の変更は脚質転換の
                                           -- サインとされる）ため、race単位で持つ必要がある。
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (race_id, car_num)
);

CREATE TABLE IF NOT EXISTS results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    snum        TEXT NOT NULL REFERENCES racers(snum),
    car_num     INTEGER NOT NULL,
    finish_pos  INTEGER,                  -- 着順
    kimarite    TEXT,                     -- 決まり手
    agari_time  REAL,                     -- 上がりタイム（秒）。WINTICKETの結果ページ「上り」列。
                                           -- 2日目以降のレースで前日（同一開催内）の上がりタイムを
                                           -- 調子の指標として使えるか検証中（未採用・実装検討中）。
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (race_id, car_num)
);

CREATE TABLE IF NOT EXISTS odds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    bet_type      TEXT NOT NULL,          -- 単勝/2車複/3連単など
    combination   TEXT NOT NULL,          -- 車番の組み合わせ（例: "1-2-3"）
    odds_value    REAL,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))  -- オッズの推移を追うための取得時刻
);

-- レース発走前に保存する予想のスナップショット。
-- resultsやracer_race_historyは後から更新され続けるため、後で振り返るには
-- 「予想した時点でのスコア・印」を固定して残しておく必要がある。
CREATE TABLE IF NOT EXISTS predictions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id            INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    car_num            INTEGER NOT NULL,
    snum               TEXT NOT NULL,
    mark               TEXT NOT NULL,        -- ◎○▲△×
    total_score        REAL NOT NULL,
    line_score         REAL NOT NULL,
    kyakushitsu_score  REAL NOT NULL,
    stats_score        REAL NOT NULL,
    formation          TEXT,                   -- ◎行にのみ設定。実際に表示した「本命」
                                                 -- シナリオの3連単フォーメーション(JSON配列)。
                                                 -- /history等の的中判定を実際の買い目と一致させるため。
    predicted_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (race_id, car_num)
);

-- 展開シナリオ（本命／逃げ粘り込み／まくり差し一撃／単騎一撃）ごとの
-- バックテスト実績（的中率・回収率）のキャッシュ。scripts/backtest.tsを実行する
-- たびに再集計してUPSERTする（毎回全レースを再予想し直すのは重いため、
-- アプリ側（買い目提案画面）はこのキャッシュを読むだけにする）。
CREATE TABLE IF NOT EXISTS scenario_stats (
    label       TEXT PRIMARY KEY,   -- 例: "本命", "逃げ粘り込み"
    races       INTEGER NOT NULL,   -- そのシナリオが登場したレース数
    hits        INTEGER NOT NULL,   -- 3連単フォーメーションが的中した回数
    stake_yen   INTEGER NOT NULL,   -- 賭け金合計（1点100円換算）
    payout_yen  REAL NOT NULL,      -- 払戻金合計
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 本命以外のシナリオ（逃げ粘り込み/まくり差し一撃/単騎一撃）の的中率を、
-- RaceScenario.likelyRank（そのレースでの有力度順位。軸のスコアが本命に
-- どれだけ肉薄しているか）別に集計する。scripts/diagnose-scenario-condition.tsで
-- 検証：likelyRank=2は的中率9.6%、3は4.7%、4は1.5%と、train/testホールドアウトで
-- ほぼ完全に再現する明確な階段状の信号だった（scenario_statsのラベル別・
-- 全レース累計だけでは「本命が一番当たる」という当たり前の情報しか出せず、
-- レースごとの状況に応じた「おすすめ」にならないというユーザー指摘を受けて追加）。
-- ラベルはまたがず合算する（3種のシナリオで個別に見ても同じ傾向だったため）。
CREATE TABLE IF NOT EXISTS scenario_rank_stats (
    likely_rank INTEGER PRIMARY KEY, -- 2, 3, 4（本命=1は対象外）
    races       INTEGER NOT NULL,
    hits        INTEGER NOT NULL,
    stake_yen   INTEGER NOT NULL,
    payout_yen  REAL NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 結果未確定（これから走る）レースの◎-対抗スコア差を事前計算してキャッシュする。
-- ホーム画面の「本日の厳選レース」用。predictRaceは1レースあたりDBを20回近く
-- 読むため、当日全レース分（最大94件/日）をリクエストの都度計算すると数秒〜十数秒
-- かかる（scripts/daily-picks.tsの計測値）。daily-sync.yml実行のたびに事前計算して
-- ここに保存し、ホーム画面はこのテーブルを読むだけにする。
CREATE TABLE IF NOT EXISTS daily_picks (
    race_id        INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
    kaisai_date    TEXT NOT NULL,
    jocd           TEXT NOT NULL,
    keirinjo_name  TEXT NOT NULL,
    race_no        INTEGER NOT NULL,
    start_time     TEXT,
    margin         REAL NOT NULL,      -- ◎と対抗の総合スコア差
    honmei_car_num INTEGER NOT NULL,
    honmei_name    TEXT NOT NULL,
    formation      TEXT,               -- 本命フォーメーションの組み合わせ（JSON配列、例: ["1-2-3","1-3-2"]）。
                                        -- 予想時点のスナップショットとして保存し、後で「前日の的中結果」
                                        -- 「直近N日の回収率」を過去のスコアリングロジックのまま再現できるようにする。
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_picks_date ON daily_picks(kaisai_date, margin DESC);

-- 「バリカタ」レース（scripts/diagnose-barikata.ts・-line.tsで検証）：
-- margin>=8 かつ予想1-2-3位（スコア順）が同じライングループのレースだけを対象に、
-- 3連単フォーメーションではなく単一の並び（1点、100円）で買う前提の別枠。
-- 検証の結果、この条件のレースは単一の並び的中率が32.7%（margin単体の場合の
-- 約2倍）、的中時平均オッズ4.13倍で、1点買いの回収率は約140%だった
-- （厳選＝daily_picksのフォーメーション買いとは狙いが異なる別カテゴリ）。
CREATE TABLE IF NOT EXISTS barikata_picks (
    race_id        INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
    kaisai_date    TEXT NOT NULL,
    jocd           TEXT NOT NULL,
    keirinjo_name  TEXT NOT NULL,
    race_no        INTEGER NOT NULL,
    start_time     TEXT,
    margin         REAL NOT NULL,
    combo          TEXT NOT NULL,      -- 予想1-2-3位の並び（例: "4-7-1"）。単一の3連単の買い目。
    honmei_car_num INTEGER NOT NULL,
    honmei_name    TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_barikata_picks_date ON barikata_picks(kaisai_date, margin DESC);

-- 「バリカタ候補漏れ」：margin>=8だがbarikata_picksの条件のうち「予想1-2-3位が
-- 同じラインか」だけを満たさなかったレース（9車立ては対象外＝barikata_picksと同じ）。
-- diagnose-barikata-line.tsの検証で、同じmargin帯でも同ライン決着でないと
-- 単一の並び的中率が大きく下がることが分かっている（例: margin10-15で
-- 同ライン32.7%に対し別ライン混在9.5%、margin15-20で41.4%対12.8%、
-- margin20+で22.2%対8.5%）。そのためバリカタとしては採用しないが、
-- 「marginは強いのになぜ外れたか」を確認できるよう参考表示用に別枠で残す
-- （barikata_picksと違い、単一の並びの的中率が低いことが分かっているため
-- 同列の推奨扱いはしない）。
CREATE TABLE IF NOT EXISTS barikata_near_misses (
    race_id        INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
    kaisai_date    TEXT NOT NULL,
    jocd           TEXT NOT NULL,
    keirinjo_name  TEXT NOT NULL,
    race_no        INTEGER NOT NULL,
    start_time     TEXT,
    margin         REAL NOT NULL,
    combo          TEXT NOT NULL,      -- 予想1-2-3位の並び（参考値。ラインが割れているため信頼度は低い）。
    honmei_car_num INTEGER NOT NULL,
    honmei_name    TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_barikata_near_misses_date ON barikata_near_misses(kaisai_date, margin DESC);

-- お気に入り選手登録。個人利用アプリのためユーザー区分なし（単一グローバルリスト）。
CREATE TABLE IF NOT EXISTS favorite_racers (
    snum        TEXT PRIMARY KEY REFERENCES racers(snum) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id);
CREATE INDEX IF NOT EXISTS idx_entries_race ON entries(race_id);
CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id);
CREATE INDEX IF NOT EXISTS idx_odds_race ON odds(race_id);
CREATE INDEX IF NOT EXISTS idx_races_date_jocd ON races(kaisai_date, jocd);

-- getPositionWinRates（lib/repository.ts）は WHERE e.snum = ? で entries を絞るが、
-- 既存の idx_entries_race は race_id 用のため使えず entries 全件スキャンになっていた。
-- backtest/diagnose 系は1レースあたり出走選手ぶん（7回前後）呼ぶため、読取行数が
-- レース数×entries件数×7 に膨らむ。Turso は行スキャン数が課金対象なのでこれが効く。
CREATE INDEX IF NOT EXISTS idx_entries_snum ON entries(snum);

-- getVenueKimariteRates は WHERE ra.jocd = ? で races を絞るが、既存の
-- idx_races_date_jocd は先頭列が kaisai_date のため jocd 単独の絞り込みには使えず、
-- races 全件スキャンになっていた。
CREATE INDEX IF NOT EXISTS idx_races_jocd ON races(jocd);
