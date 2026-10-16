# 家事コーチ（household-bot）

一人で生活習慣を回すための LINE Bot。毎朝「今日の小さな家事1つ」を送り、ゴミの日などの毎週の予定、締め切り、日々の支出を LINE だけで管理する。月末には支出を集計し、表・グラフ・CSV のページへのリンク付きでレポートを送る。

## できること

| 送るメッセージ | 動作 |
|---|---|
| `今日のタスク` | 今日の小タスクを返す（平日のみ） |
| `追加: レポート 金曜まで` | 締め切りを登録。「金曜」「来週の月曜」「10/20」「20日」「明日」を読み取る |
| `締め切り` | 締め切りを近い順に一覧（残り日数・期限切れを表示） |
| `削除 1` | 一覧の番号で締め切りを消す |
| `支出 1200 食費 ランチ` | 支出を記録（金額・カテゴリ・メモ）。今週・今月の合計を返す |
| `取消` | 直前の支出を取り消す |
| `今月` / `先月` | カテゴリ別の集計カード（Flex Message）＋詳細ページへのボタン |
| `予定` | 毎週の予定の一覧 |
| `予定設定` | 予定を追加・変更・削除できるページのリンク（30分有効・本人のみ） |

**自動で届く通知（日本時間）**

- 平日6時：今日の小タスク
- 21時：明日の予定の予告・今夜の予定・支出記録の呼びかけを **1通にまとめて**
- 予定ごとに設定した時刻：当日の通知
- 8時：締め切りの3日前・前日・当日
- 日曜22時：今週の支出合計
- 月末22時：月次レポート（カテゴリ別の集計、日別グラフ、明細、CSV ダウンロード）

## 構成

```
LINE ──Webhook──▶ Cloudflare Workers ──▶ Workers KV（締め切り・支出・予定）
      ◀─Reply/Push─      ▲ Cron（毎時）
                         ├─ /report/YYYY-MM（HTML・CSV）
                         └─ /settings（予定の編集）
```

- **Cloudflare Workers**：サーバーを持たずに Webhook と定期実行（Cron Trigger）を動かす。無料枠で足りる
- **Workers KV**：締め切りは1キー、支出は月ごとに1キー（`exp_YYYY-MM`）、予定は1キー（`schedule`）
- **予定はデータとして持つ**：曜日・時刻・文言をコードに書かず KV に保存し、ブラウザから編集できる。KV が空のときは `src/schedule.js` の見本を使う

### セキュリティ

- Webhook は `X-Line-Signature` を HMAC-SHA256 で検証し、LINE 以外からのリクエストを拒否する
- レポートページは月ごとの合言葉（チャネルシークレットから HMAC で生成）付き URL でしか開けない
- 予定の設定ページは書き換えができるため、より強く守る
  - リンクは通知先に登録した本人（`MY_USER_ID`）にだけ発行
  - 合言葉はランダムで、30分で KV から消えて無効になる
  - 入力はサーバー側で検証（曜日・時刻の範囲、文字数、件数）
  - ページへの埋め込みは `<` をエスケープし、表示は DOM API（`textContent`/`value`）のみで行う
- トークン類はコードに含めず、Wrangler の secret で管理する

```
src/
  index.js     ルーティング・メッセージ処理・定期通知
  line.js      LINE API 呼び出し、署名検証
  deadline.js  締め切りの日付解析・リマインド
  expense.js   支出の記録・集計
  report.js    Flex Message／HTML／CSV の生成
  schedule.js  毎週の予定（見本の初期値・検証・通知文）
  settings.js  予定の設定ページ（期限付きリンク・HTML）
  time.js      日本時間の日付計算
test/          node:test によるテスト（LINE・KV はモック）
```

## セットアップ

1. [LINE Developers](https://developers.line.biz/) で Messaging API チャネルを作り、チャネルシークレットとチャネルアクセストークン（長期）を控える
2. Cloudflare にログインして KV を作る
   ```bash
   npx wrangler login
   cp wrangler.example.toml wrangler.toml
   npx wrangler kv namespace create TASKS_KV   # 表示された id を wrangler.toml に貼る
   ```
3. 秘密情報を登録してデプロイ
   ```bash
   npx wrangler secret put LINE_TOKEN          # チャネルアクセストークン
   npx wrangler secret put LINE_CHANNEL_SECRET # チャネルシークレット
   npx wrangler deploy
   ```
4. LINE Developers の Webhook URL に `https://<表示されたURL>/webhook` を設定し、「Webhookの利用」をオン
5. Bot を友だち追加して `myid` と送り、返ってきた ID を登録
   ```bash
   npx wrangler secret put MY_USER_ID
   ```
6. `予定設定` と送って、自分の予定を入れる

### うまく動かないとき

- **既読になるだけで返事がない**：`npx wrangler secret list` で `LINE_CHANNEL_SECRET` があるか確認する（署名検証に必須）
- **「予定設定」で断られる・通知が届かない**：Bot に `myid` と送り、返ってきた ID を `MY_USER_ID` に登録し直す（ユーザー ID はチャネルごとに異なる）
- ログは `npx wrangler tail` で見られる

## 開発

```bash
npm test                 # テスト
npx wrangler dev         # ローカル実行
npx wrangler tail        # 本番のログを見る
```

## ライセンス

MIT
