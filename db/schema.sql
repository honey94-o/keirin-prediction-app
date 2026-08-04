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
    race_date         TEXT NOT NULL,        -- MM/DD（年をまたぐ場合の厳密な年特定はしていない簡易版）
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
    predicted_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (race_id, car_num)
);

-- 本日発売中の開催場一覧のキャッシュ。VercelはPlaywrightを実行できないため、
-- GitHub Actions側（sync_today_venues）で取得してここに保存し、
-- Next.jsアプリの「新しいレースを取得」フォームの選択肢に使う。
CREATE TABLE IF NOT EXISTS today_venues (
    venue_name  TEXT PRIMARY KEY,
    synced_date TEXT NOT NULL,   -- YYYYMMDD（この一覧が本日分かを判定するため）
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id);
CREATE INDEX IF NOT EXISTS idx_entries_race ON entries(race_id);
CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id);
CREATE INDEX IF NOT EXISTS idx_odds_race ON odds(race_id);
CREATE INDEX IF NOT EXISTS idx_races_date_jocd ON races(kaisai_date, jocd);
