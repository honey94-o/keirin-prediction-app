# 競輪予想アプリ

個人利用の競輪予想PWA。ライン／脚質実力／データ統計の3本柱でスコアリングし、印（◎○▲△×）と買い目候補を提示する。

設計の詳細は以下を参照:

- [`01_競輪予想アプリ_仕様会議まとめ.md`](./01_競輪予想アプリ_仕様会議まとめ.md) — 仕様・設計書
- [`02_Claude_Code_開発プロンプト集.md`](./02_Claude_Code_開発プロンプト集.md) — Phase別の開発プロンプト集

## フォルダ構成

| フォルダ | 内容 |
|---|---|
| `app/` | Next.js App Router（画面・manifest） |
| `lib/` | 共通ロジック・スコアリング関数・DB接続 |
| `components/` | Reactコンポーネント |
| `scraper/` | Pythonスクレイピングスクリプト |
| `db/` | DBスキーマ・初期化スクリプト |
| `.github/workflows/` | GitHub Actions（スクレイパーの手動/定期実行） |

## データベース：Turso（libSQL）

外出先のiPhoneからも常時アクセスできるよう、DBはローカルファイルではなく
[Turso](https://turso.tech)（SQLite互換のクラウドDB、無料枠あり）を使う。
Next.js（`@libsql/client`）とPythonスクレイパー（`libsql-client`）の両方が
同じTursoデータベースを読み書きする。

### 1. Tursoデータベースを作成する

1. [turso.tech](https://turso.tech) でアカウント作成（GitHubログイン可）
2. ダッシュボードで新しいデータベースを作成
3. データベース詳細ページで以下を控える：
   - **Database URL**（`libsql://xxxx.turso.io`）
   - **Auth Token**（Create Tokenで発行）

### 2. ローカル環境変数の設定

```bash
cp .env.local.example .env.local
# .env.local を編集して TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を埋める
```

### 3. スキーマ初期化

```bash
cd scraper
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
playwright install chromium

cd ..
scraper\.venv\Scripts\python.exe db\init_db.py
```

**動作確認済み。**Python版`libsql-client`(0.3.1)は`libsql://`（WebSocket/Hrana）接続だと環境によってハンドシェイクに失敗することがあったため、`scraper/db.py`内で`https://`に自動変換して接続している（TypeScript側の`@libsql/client`は`libsql://`のままで問題ない）。また同クライアントのHTTPトランスポートは対話的トランザクション（BEGIN/COMMIT）に非対応のため、`keirin_scraper.py`の`save_to_db`は「race行の確定はRETURNING付きの単発execute、残りは1回のbatch()にまとめて送信」という方式にしている。

## ローカル起動手順

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) をブラウザで開く（`.env.local` の設定が必要）。

### iPhoneでPWAとして確認する（本番URL）

1. Vercelにデプロイ後の本番URL（`https://xxxx.vercel.app`）にiPhoneのSafariでアクセス
2. 共有ボタン → 「ホーム画面に追加」
3. ホーム画面のアイコンから起動し、アドレスバーなしのアプリらしい表示になっていることを確認
4. 外出先（Wi-Fi以外の回線）でも同じURLでアクセスできることを確認

## デプロイ手順（Vercel + Turso + GitHub Actions）

### 1. GitHubリポジトリを作成してpush

```bash
gh auth login          # 初回のみ・ブラウザでの認証が必要
gh repo create keirin-prediction-app --private --source=. --remote=origin
git push -u origin master
```

### 2. GitHub Secretsを設定（Actionsでのスクレイパー実行用）

```bash
gh secret set TURSO_DATABASE_URL --body "libsql://xxxx.turso.io"
gh secret set TURSO_AUTH_TOKEN --body "xxxxxxxx"
```

以降、GitHubリポジトリの「Actions」タブから `Scrape keirin race data` ワークフローを手動実行（`workflow_dispatch`）すると、PCを起動していなくてもレースデータを取得できる。デフォルトではスケジュール実行は無効にしてある（`.github/workflows/scrape.yml` 内のcronはコメントアウト）。有効化する場合も、KEIRIN.JPへの節度あるアクセス（低頻度・個人利用の範囲）を必ず維持すること。

### 3. Vercelにデプロイ

```bash
npx vercel login       # 初回のみ・ブラウザでの認証が必要
npx vercel link
npx vercel env add TURSO_DATABASE_URL production
npx vercel env add TURSO_AUTH_TOKEN production
npx vercel --prod
```

またはVercelダッシュボードでGitHubリポジトリをImportし、Environment VariablesにTURSO_DATABASE_URL/TURSO_AUTH_TOKENを設定してデプロイしてもよい（以後はgit pushで自動デプロイされる）。

## 開発の進め方

`02_Claude_Code_開発プロンプト集.md` のPhase 0〜5を順番に投入し、フェーズごとに動作確認しながら進める。

- [x] Phase 0: プロジェクト初期化＋PWA設定
- [x] Phase 1: DB設計＋スクレイピングモジュール（1レース分の手動取得まで確認済み）
- [x] Phase 2: 予想ロジック実装（3本柱スコアリング、`npm run score <race_id>` で確認済み）
- [x] Phase 3: UI実装（レース一覧・出走表予想・買い目提案・選手データの4画面、モバイル幅で動作確認済み）
- [x] Phase 4: 設定・重み調整・精度検証機能（設定画面・予想記録・履歴/精度検証画面、動作確認済み）
- [x] Phase 5: デプロイ・iPhone動作確認（Turso移行・Vercelデプロイ手順整備。実際のデプロイ・iPhone確認はユーザー側の認証操作待ち）

## データ取得（スクレイピング）

```bash
cd scraper
# 本日発売中の開催場一覧を確認
.venv\Scripts\python.exe keirin_scraper.py --list-venues

# 1レース分だけ取得してDBに保存
.venv\Scripts\python.exe keirin_scraper.py --venue-index 0 --race-no 1
```

**既知の制約・注意点：**

- KEIRIN.JPのrobots.txtは出走表・オッズ・結果ページを許可リストに含めていない。本プロジェクトは個人利用として非準拠で実装している（[01_競輪予想アプリ_仕様会議まとめ.md](./01_競輪予想アプリ_仕様会議まとめ.md)の注意点も参照）。アクセス頻度は絶対に上げないこと。
- サイトはJSFベースのステートフルな作りで、`data-encp` という暗号化パラメータとセッションに強く依存する。サイト側のUIボタンをクリックしてサイト自身にAJAX（`/pc/json?type=...`）を発行させ、その応答を横取りする方式で実装している（`keirin_scraper.py` の `JsonCapture`）。サイト構造が変わると壊れやすい。
- 現状オッズは3連単のみ対応（`JST011` の `kake` パラメータを変えれば他の券種にも拡張可能）。
- ライン情報（隊列構成・番手位置）は`narabiyoso`（並び予想）から取得済み。ただしレース確定前の一定期間しか提供されないことがある（`ryoikiFlg`が`false`の場合は未提供）。
- 複数日開催の場合、開催場ページはデフォルトで初日を表示するため、本日の日付タブに自動で切り替える処理を入れている（`_switch_to_today`）。単日開催では何もしない。
- バンク特性（周長・直線長・カント・決まり手傾向）は `/pc/jyoguide`（robots.txt許可ページ）から取得し `bank_info` テーブルに保存。開催場単位でほぼ不変なため30日キャッシュ。
- 選手の出走間隔・過去の同条件成績は `/pc/racerprofile`（robots.txt許可ページ）の「最近の成績」から `racer_race_history` テーブルに保存。日付はMM/DDのみで年を厳密に特定していない簡易実装。選手単位で1日キャッシュ。
- 天候は `races.tenki`/`races.husoku` に保存されるが、**レース終了後の実績値のみ**取得可能（事前予報ではない）。そのためスコアリングには反映していない（過去レースの振り返り分析用）。
- ギア倍数は未取得（選手プロフィールページ側でのさらなる補完が必要）。

## 過去レースの取得（バックテスト用・WINTICKET）

KEIRIN.JPは「本日/明日」のライブ発売中レースしか出走表・結果を取得できる入口がなく、
過去日程はカレンダー表示のみでクリック不可（過去レースのバックテストが作れない）。
そのため過去データの取得だけは公式ネット投票サイト WINTICKET を使う
（`scraper/winticket_scraper.py`）。こちらはPlaywright不要、素のHTTP GET + BeautifulSoup
でSSRされたHTMLから直接パースできる。

```bash
cd scraper
.venv\Scripts\python.exe winticket_scraper.py --venue iwakidaira --days-back 7
```

- 出走表: `https://winticket.jp/keirin/{venue}/racecard/{cupId}/{day}/{raceNo}`
- 結果: `https://winticket.jp/keirin/{venue}/raceresult/{cupId}/{day}/{raceNo}`
- 開催日程一覧: `https://winticket.jp/keirin/{venue}/schedule/{YYYYMM}`（`cupId`＝開催初日8桁+開催場コード2桁を列挙）
- 各cupIdについて day=1.. / raceNo=1.. を404が返るまで反復して開催全体を走査する。
- 選手の識別キー（`racers.snum`）はKEIRIN.JP側の選手登録番号と体系が異なる可能性があるため、
  衝突を避けて `"wt" + WINTICKETのcyclist ID`を使う（KEIRIN.JP由来のレコードとは別選手として扱われる）。
- DB保存は`keirin_scraper.py`の`RaceData`/`save_to_db`をそのまま流用（スキーマはデータ取得元に依存しない）。
- 現状`racer_race_history`（出走間隔・同開催場成績用）とバンク特性は取得していないため、
  WINTICKET由来のレースはデータ統計スコアの一部がニュートラル値になる（既知の制約）。
- 節度あるアクセス間隔（デフォルト1.5秒/回）を必ず空けること。全国全開催場の長期間取得は
  数千リクエスト規模になるため、対象開催場・期間を絞って段階的に実行すること。

### バックテスト集計（的中率・回収率）

```bash
npx tsx scripts/backtest.ts        # 結果が確定している全レース
npx tsx scripts/backtest.ts 13,63  # 開催場コードで絞り込み（例: いわき平・防府）
```

結果(`results`)が確定している全レースに対して現在のスコアリング・シナリオ生成ロジックで
`predictRace()`を再実行し（`predictions`テーブルにもスナップショットを保存するため`/history`
画面にも反映される）、実際の着順と照合してシナリオ別・3連複ボックスの的中率と回収率を出力する。
回収率はWINTICKET結果ページの確定払戻金から算出（3連単のみ。3連複の払戻は未取得）。

### 予想ロジックの検証・再調整用スクリプト

```bash
npx tsx scripts/diagnose-ranking.ts     # 総合スコア順位と実際の1着の関係、脚質・隊列位置・決まり手の分布
npx tsx scripts/diagnose-truerates.ts   # 隊列内位置・ライン人数・脚質ごとの「真の勝率」（母数で正規化）
npx tsx scripts/diagnose-linefinish.ts  # 上位3着の隊列位置の組み合わせ（同ライン決着か、番手差しか等）
```

スコアリングの重みを勘や一般論だけで調整すると、見かけ上もっともらしくても実際には
改善しない（むしろ悪化する）ことがある。例：2026年8月時点で43開催場・約1000レースの
バックテストで「実際の1着の65%がライン先頭だった」ことが分かったため、隊列位置の
配点を先頭優遇に変更したところ、単体では◎的中率がわずかに改善したが、脚質評価側
（`calculateKyakushitsuScore`の`fitScore`、逃×先頭を優遇）と同時に適用すると
情報が重複してかえって◎的中率・回収率とも悪化した（先頭に立つ選手はもともと
「逃」脚質であることが多く、両方に同じ強さの根拠を二重に加点してしまうため）。
最終的には脚質側の調整のみを残し、ライン側の隊列位置配点は据え置いている
（`lib/scoring.ts`の`calculateLineScore`のコメント参照）。

もう一例：`diagnose-linefinish.ts`で「1着が番手だった時、2着は同ラインの先頭
（自分の前を走っていた選手がそのまま粘る）」が53.2%と最多だと分かったため、
まくり/差し一撃シナリオの2・3着候補プールを「差された側（本命ライン）優先」から
「軸自身のライン優先」に変更したところ、まくり/差し一撃の的中率が5.2%→6.2%、
全シナリオ合成の的中率が29.7%→30.6%に改善した。

**重みを調整する際は必ずこれらの診断スクリプトと`scripts/backtest.ts`で
「変更前後」を比較してから採用すること。**

## 予想ロジック（スコアリング）

```bash
npm run score <race_id>   # 例: npm run score 1
```

Tursoに保存されている `races.id` を指定すると、①ライン ②脚質実力 ③データ統計 の3スコアと
総合スコア・印（◎○▲△×）・3連単フォーメーション/3連複ボックス候補を表示する。
重みは `settings` テーブル（`score_weight_line` 等）で調整可能（`/settings` 画面から編集可能）。

**展開パターン別の複数予想（`generateScenarios`）：** 総合スコア1位を機械的に軸にするだけでなく、レース展開が複数ありうることを踏まえて2〜4パターンの軸候補を出す。
- **本命**：総合スコア1位がそのまま押し切る想定
- **逃げ粘り込み**：ライン先頭の選手が番手・3番手に守られて単独で粘り切る想定
- **まくり/差し一撃**：先頭以外の位置で脚質が追・両（追い込み適性）の選手が外から差す想定。バンクの捲り決まり手率（`bank_info.makuri_pct`）が高いほど根拠として言及される
- **単騎一撃**：ライン人数1（単騎）の選手が対象。単騎は隊列構成上ライン評価が低く出やすいが、個人の実力（脚質実力・データ統計スコア）が高ければ距離や出走間隔に関わらず単独で上位に飛び込むことがあるため、ライン評価を除いた個人力が最も高い単騎選手を軸にする

各パターンで軸を変え、それぞれ「1頭軸流し」形式のフォーメーションを生成する。2着・3着候補は総合スコア順ではなく、パターンごとの優先ライン（本命／逃げ粘り込みは軸と同じライン、まくり/差し一撃は差される側＝本命ラインのメンバー、単騎一撃は優先ラインなし＝総合スコア順）を先頭に並べた専用プールから選ぶ（`buildLineAwarePool`）。点数は各パターンの予算（20点をパターン数で均等割り）内でM×(M-1)が収まる最大のMを自動選択し（`formationFromPool`）、全パターン合計が3連単20点の上限を超えないようにする。同じ選手が複数パターンの軸に重複する場合は後続パターンをスキップし、実質的に異なる決着筋だけを出す。3連複ボックスは展開パターンに依らない上位4車の総当たり（保険的な買い方）として別枠で1つだけ表示する。

**データ統計スコアの内訳（重み内訳）：**
- バンク適性(20%)／出走間隔(15%)／過去の同開催場成績(20%)／位置別勝率(20%)／連対率(25%)
- **オッズは意図的に不使用**（群衆の人気度を自分の予想スコアに混ぜると群衆と同じ判断に収束してしまうため）。オッズ自体はDBに保存されるが、スコアリングでは参照しない。
- 天候は事前予報が存在しないため対象外（`races.tenki`にレース終了後の実績値のみ保存、振り返り分析用）

**位置別勝率：** 公式サイトに統計が存在しないため、自前で蓄積した `entries.line_position` × `results.finish_pos` から算出する（`getPositionWinRates()`）。母数が少ないうちは選手自身の通算勝率を事前分布としたベイズ縮小推定で極端な値を抑えている（`calculatePositionWinRateScore`）。スクレイピング件数が増えるほど精度が上がる。

**昇級・降級（脚質実力スコアに反映）：**
- 競輪の級班替えは毎年1月・7月。`racers.prev_class_rank`（前期級班）と`class_rank`（今期級班）を比較し昇級/降級を判定する。
- 切り替え1ヶ月目（1月・7月）は全量、2ヶ月目（2月・8月）は半量で、降級選手（新しい級では相対的に格上）に加点、昇級選手（格上の相手と走る）に減点する調整を入れる。3ヶ月目以降は調整なし（`classChangeAdjustmentFactor`）。

**その他の制約：**
- ギア倍数は未取得のため脚質実力スコアには含めていない。
- オッズは1回分のスナップショットのみのため「オッズの動き（推移）」は未反映。
- 過去の同条件成績は開催場名の1文字一致による近似マッチング（`venue_abbr`が略称のため）。

## 画面構成（UI）

| 画面 | パス | 内容 |
|---|---|---|
| レース一覧 | `/` | DB登録済みレースを開催日＋開催場でグルーピング表示 |
| 出走表・予想 | `/races/[id]` | 車番・印・総合スコア・3スコア内訳（ライン/脚質実力/データ統計）・ライングループ表示 |
| 買い目提案 | `/races/[id]/bets` | 展開パターン別（本命／逃げ粘り込み／まくり差し）に、2・3着候補をライン考慮で絞った3連単フォーメーションを複数提示（合計20点以内）＋3連複ボックス |
| 選手データ | `/racers/[snum]` | 通算成績・隊列内位置別勝率・最近の成績（直近履歴） |
| 設定 | `/settings` | ①ライン ②脚質実力 ③データ統計の重みをスライダーで調整（3値の比率で自動正規化） |
| 予想履歴・精度検証 | `/history` | 記録した予想と結果を突き合わせ、的中率・回収率を集計 |

車番バッジは実際の競輪の帽子色規則（1白/2黒/3赤/4青/5黄/6緑/7橙/8桃/9紫）に合わせている。
`lib/predict.ts` の `predictRace()` がスコア計算に必要なデータ取得〜`scoreRace()`呼び出しまでを一括で行い、CLI（`npm run score`）とUIの両方から共有している。

## 精度検証機能（Phase 4）

出走表画面の「この予想を記録する」ボタンで、その時点のスコア・印を `predictions` テーブルにスナップショット保存する（発走前に記録する想定）。レース結果（`results`）が揃うと、履歴画面で以下を自動集計する：

- ◎の単勝的中率／複勝的中率（3着以内）
- 3連単フォーメーションの的中率
- 回収率（フォーメーション各点に100円均等買いした場合の参考値。的中点のオッズは予想記録時点のスナップショットを使うため、公式の確定払戻金とは異なる場合がある）

`predictions`にスナップショットを残すのは、`racer_race_history`や`results`など元データが後から更新され続けるため、「予想した時点のスコア」を固定して振り返れるようにするため。

## 技術スタック

- Next.js（App Router）＋ TypeScript ＋ Tailwind CSS
- PWA対応（`app/manifest.ts` によるNext.js組み込みのWeb App Manifest）
- DB: Turso（libSQL、SQLite互換のクラウドDB。Phase 5でローカルSQLiteから移行）
  - TS側: `@libsql/client`（`lib/db.ts`）
  - Python側: `libsql-client`（`scraper/db.py`）
- スクレイピング: Python + Playwright（Phase 1で導入）
- デプロイ: Vercel（フロントエンド）＋ GitHub Actions（スクレイパーの手動/定期実行）
