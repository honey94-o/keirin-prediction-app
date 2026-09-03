-- 競輪予想アプリ DBスキーマ（Postgres / Neon版）
-- db/schema.sql（SQLite/Turso版）と同じ内容をPostgres方言に移植したもの。
-- created_at/updated_at等は元のSQLiteの datetime('now') と同じ
-- "YYYY-MM-DD HH:MM:SS" 形式の文字列を保つため、TIMESTAMPTZ型ではなく
-- あえてTEXT + to_char(now(), ...)にしている（アプリ・スクレイパー側の
-- 文字列パース処理を変えずに済ませるため）。

CREATE TABLE IF NOT EXISTS races (
    id            SERIAL PRIMARY KEY,
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
    created_at    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
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
    updated_at      TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
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
    kimarite_nige_count    INTEGER,       -- 逃げで1-2着になった回数
    kimarite_makuri_count  INTEGER,       -- 捲りで1-2着になった回数
    kimarite_sashi_count   INTEGER,       -- 差しで1-2着になった回数
    kimarite_mark_count    INTEGER,       -- マークで1-2着になった回数
    standing_count INTEGER,               -- 好スタート回数
    home_lead_count INTEGER,              -- 最終周回ホーム線を先頭通過した回数
    back_lead_count INTEGER,              -- 最終周回バック線を先頭通過した回数
    debut_class      TEXT,                 -- 期（例: "129期"）
    tt200_sec        REAL,                 -- 200mタイムトライアル(秒)
    tt400_sec        REAL,                 -- 400mタイムトライアル(秒)
    tt500_sec        REAL,                 -- 500mタイムトライアル(秒、女子のみ)
    tt1000_sec       REAL,                 -- 1000mタイムトライアル(秒、男子のみ)
    tt2000_sec       REAL,                 -- 2000mタイムトライアル(秒、女子のみ)
    tt3000_sec       REAL,                 -- 3000mタイムトライアル(秒、男子のみ)
    kisokukai_grade  TEXT,                 -- 能力別総合評価（S/A/B/C/D）
    updated_at     TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- 選手ごとの直近レース履歴（出走間隔・過去の同条件成績の算出に使う）。
-- 選手プロフィールページの「最近の成績」（直近8走）から取得する簡易版。
CREATE TABLE IF NOT EXISTS racer_race_history (
    id                SERIAL PRIMARY KEY,
    snum              TEXT NOT NULL REFERENCES racers(snum),
    race_date         TEXT NOT NULL,        -- MM/DD（年をまたぐ場合の厳密な年特定はしていない簡易版）
    venue_abbr        TEXT,                 -- 開催場の略称（例: "豊"）＋グレード（例: "Ｆ２"）
    finish_positions  TEXT,                 -- その開催内の各レース着順をカンマ区切りで（例: "6,5,5"）
    scraped_at        TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE (snum, race_date, venue_abbr)
);

CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

INSERT INTO settings (key, value) VALUES ('score_weight_line', '0.35') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('score_weight_kyakushitsu', '0.35') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('score_weight_stats', '0.30') ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS entries (
    id            SERIAL PRIMARY KEY,
    race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    snum          TEXT NOT NULL REFERENCES racers(snum),
    car_num       INTEGER NOT NULL,       -- 車番
    line_group    INTEGER,                -- ラインのグループ番号
    line_position TEXT,                   -- 先頭・番手・3番手など
    pref          TEXT,                   -- 府県（地元の場合「東京（地元）」のように付与）
    created_at    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE (race_id, car_num)
);

CREATE TABLE IF NOT EXISTS results (
    id          SERIAL PRIMARY KEY,
    race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    snum        TEXT NOT NULL REFERENCES racers(snum),
    car_num     INTEGER NOT NULL,
    finish_pos  INTEGER,                  -- 着順
    kimarite    TEXT,                     -- 決まり手
    created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE (race_id, car_num)
);

CREATE TABLE IF NOT EXISTS odds (
    id            SERIAL PRIMARY KEY,
    race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    bet_type      TEXT NOT NULL,          -- 単勝/2車複/3連単など
    combination   TEXT NOT NULL,          -- 車番の組み合わせ（例: "1-2-3"）
    odds_value    REAL,
    recorded_at   TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')  -- オッズの推移を追うための取得時刻
);

-- レース発走前に保存する予想のスナップショット。
CREATE TABLE IF NOT EXISTS predictions (
    id                 SERIAL PRIMARY KEY,
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
    predicted_at       TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    UNIQUE (race_id, car_num)
);

CREATE TABLE IF NOT EXISTS scenario_stats (
    label       TEXT PRIMARY KEY,   -- 例: "本命", "逃げ粘り込み"
    races       INTEGER NOT NULL,   -- そのシナリオが登場したレース数
    hits        INTEGER NOT NULL,   -- 3連単フォーメーションが的中した回数
    stake_yen   INTEGER NOT NULL,   -- 賭け金合計（1点100円換算）
    payout_yen  REAL NOT NULL,      -- 払戻金合計
    updated_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- 結果未確定（これから走る）レースの◎-対抗スコア差を事前計算してキャッシュする。
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
    formation      TEXT,               -- 本命フォーメーションの組み合わせ（JSON配列）
    updated_at     TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_daily_picks_date ON daily_picks(kaisai_date, margin DESC);

-- 「バリカタ」レース。db/schema.sqlのコメント参照。
CREATE TABLE IF NOT EXISTS barikata_picks (
    race_id        INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
    kaisai_date    TEXT NOT NULL,
    jocd           TEXT NOT NULL,
    keirinjo_name  TEXT NOT NULL,
    race_no        INTEGER NOT NULL,
    start_time     TEXT,
    margin         REAL NOT NULL,
    combo          TEXT NOT NULL,
    honmei_car_num INTEGER NOT NULL,
    honmei_name    TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_barikata_picks_date ON barikata_picks(kaisai_date, margin DESC);

-- お気に入り選手登録。個人利用アプリのためユーザー区分なし（単一グローバルリスト）。
CREATE TABLE IF NOT EXISTS favorite_racers (
    snum        TEXT PRIMARY KEY REFERENCES racers(snum) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id);
CREATE INDEX IF NOT EXISTS idx_entries_race ON entries(race_id);
CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id);
CREATE INDEX IF NOT EXISTS idx_odds_race ON odds(race_id);
CREATE INDEX IF NOT EXISTS idx_races_date_jocd ON races(kaisai_date, jocd);
CREATE INDEX IF NOT EXISTS idx_entries_snum ON entries(snum);
CREATE INDEX IF NOT EXISTS idx_races_jocd ON races(jocd);
