# 面接記録(運用版)設計書 v0.3

対象: 開発者・Claude Code。v0.2 の設計([design-ops-v0.2.md](design-ops-v0.2.md))に追加した部分だけを書く。
使い方は [operations.md](operations.md)。

---

## 0. v0.3 で足したもの

| 要件 | 対応 | 主なファイル |
|---|---|---|
| 面接の種類ごとに評価の観点を変えたい | 評価シート(項目+重み・質問+時間の目安・合格の目安)。面接は登録時の内容を写して持つ | `src/shared/score.ts`, `server/store.ts`(移行) |
| 一次・二次をまとめて見たい | `applicantId` で同じ候補者の面接をまとめる。「次の面接を登録」 | `server/routes/interviews.ts` |
| 面接官ごとに見られる範囲を絞りたい | 閲覧範囲 all / assigned。`/api/interviews/:id…` は入口で一律に判定 | `server/access.ts`, `server/app.ts` |
| その場にいなくても面接中に見たい | ライブ視聴(受信済みのチャンクを MSE で再生)・場面のメモ・面接室へのメッセージ | `src/app/detail/LivePanel.tsx`, `server/routes/recordings.ts` |
| 話した内容を確認したい | サーバー内の whisper.cpp で文字起こし。時刻と連動 | `server/transcribe.ts`, `src/app/detail/TranscriptPanel.tsx` |
| 記録を紙・PDF で残したい / 結果を通知したい | 記録票・合否通知書の印刷 | `src/app/pages/ReportPage.tsx`, `NoticePage.tsx`, `src/shared/notice.ts` |
| 候補者を並べて判断したい | 比較(並べ替え・絞り込み・CSV)、面接官の評価の傾向、同じ年代との表情の比較 | `server/routes/insights.ts`, `src/app/pages/ComparePage.tsx` |
| 予定を把握したい | 週の予定表・今日の面接・.ics | `src/app/pages/CalendarPage.tsx`, `src/app/ics.ts` |
| 願書などを一緒に見たい | 応募書類の添付(PDF・画像) | `server/attachments.ts`, `server/routes/attachments.ts` |
| 当日の手間を減らしたい | 事前のオンライン同意(保護者向けリンク・QR) | `server/routes/consentLinks.ts`, `src/app/pages/PublicConsentPage.tsx` |
| 動きを知らせてほしい | メール(SMTP)・評価の催促・前日のお知らせ | `server/mail.ts`, `server/notifications.ts`, `server/reminders.ts` |
| 探したい | 横断検索(候補者・メモ・評価のコメント・文字起こし) | `server/routes/search.ts` |
| 開示・引き継ぎ | 候補者のデータの ZIP 書き出し | `server/zip.ts`, `server/routes/export.ts` |
| 不正なログインを防ぎたい | 2段階認証(TOTP)・管理者への必須化 | `server/totp.ts`, `server/routes/account.ts` |
| スマートフォンで使いたい | PWA(manifest・アイコン・オフライン時の案内だけのサービスワーカー) | `public/manifest.webmanifest`, `public/sw.js` |

## 1. データ

すべて `DATA_DIR` 配下の JSON(v0.2 と同じ方式。書き込みは一時ファイル → rename)。v0.2 のデータは読み込み時に補う。

| 追加・変更 | 場所 | 補い方(v0.2 のデータ) |
|---|---|---|
| 設定 `templates` `defaultTemplateId` | settings.json | 旧 `criteria` `defaultQuestions` を「標準」の評価シートに移す |
| 設定 `access` `transcription` `notices` `security` `reminders` `retention.attachmentDaysAfterDecision` | settings.json | 既定値で補う(`mergeSettings`) |
| 面接 `applicantId` `round` `questionMinutes` `templateId` `templateName` `criteria` `passLine` | interview.json | `applicantId = id`、評価項目は既定の評価シートを写す(`normalizeInterview`) |
| 面接 `attachments` `consentLinks` | interview.json | 空配列 |
| 録画 `transcript` `transcriptError` | interview.json | `"none"` |
| 利用者 `email` `notify` `totp` `totpPending` | users.json | 空・役割ごとの既定・null |
| 応募書類のファイル | `interviews/<id>/attachments/<aid>.<ext>` | — |
| 文字起こし | `interviews/<id>/recordings/<rid>/transcript.json` | — |
| 送ったお知らせの記録 | `notify-log.json`(120日で整理) | — |

評価シートは面接ごとに**写し**を持つ。あとで評価シートを変えても、登録済みの面接の評価項目・重みは変わらない
(評価の入力後は評価シートを差し替えられない)。合計点は `Σ 評価×重み / Σ 重み`(入力済みの項目だけ)。

## 2. 見られる範囲と評価の非公開

- **閲覧範囲**: `canView(user, iv)`(`server/access.ts`)。管理者はすべて、面接官は all ならすべて、assigned なら担当・自分が登録した面接だけ。
  `/api/interviews/:id…` は `server/app.ts` の入口で一律に確かめ、見られない面接は 404(存在を知らせない)。
  一覧・比較・検索・メールの宛先・同じ候補者のほかの回も同じ関数で絞る
- **評価の非公開**(`evaluationVisibility`)は v0.2 と同じ。v0.3 で増えた入口でも守る:
  - 比較・一覧: 非公開中は票・合計点・項目の平均を返さない
  - 検索: ほかの人のメモ・評価は、非公開のうちは探さない(管理者も、自分の評価を出す前は画面と同じく伏せる)
  - 面接室へのメッセージ(`Note.kind = "room"`)は進行の連絡なので非公開の対象外
- **表情の比較**(`/api/interviews/:id/expression-compare`): 指標ごとに並べ替えた値だけを返す(どの面接の値か分からない)。
  本人のほかの回は除き、10件未満なら値を返さない。以前の `/api/stats/expression`(面接 ID つき)は廃止
- **面接官の評価の傾向**: 管理者は全員分、面接官は自分の分だけ

## 3. ライブ視聴

- 録画中の端末は 2 秒ごとのチャンクを送りながら、5 秒ごとに心拍(`POST …/live`、経過時間といまの質問)を送る。
  サーバーは「録画開始のサーバー時刻」を推定して持つ(通信の遅れのぶん後ろにずれるので、5秒以内の差なら早い方を使う)。20秒心拍がなければライブではない
- 見る側は `GET …/chunks/:i`(録画中だけ)で受信済みのチャンクを取り、MSE(`SourceBuffer`)に入れる。
  途中から見るときは、チャンク 0 の初期化部分(最初の Cluster の前まで)+ 最新に近いチャンクの Cluster の始まり(`1F43B675 01FFFFFFFFFFFFFF E7`)から入れる。
  キーフレームを 2 秒ごとに入れているので(`videoKeyFrameIntervalDuration`)、どのチャンクからでも再生を始められる
- 場面のメモ(`live: true`)の時刻は、サーバーが推定した経過時間で付ける(見る側の遅れに左右されない)

## 4. 文字起こし

- 録画の仕上げのあと、ffmpeg で 16kHz モノラルにして whisper.cpp(`whisper-cli -l ja --vad -oj`)に渡す。
  **VAD(無音の区間を飛ばす)を必ず使う**(使わないと、無音のあとの区間の時刻がずれる・同じ文の繰り返しが出る)
- 1件ずつ順番に処理し(ジョブ)、再起動したら途中のものから続ける。モデルは初回に取得して `DATA_DIR/models` に置く
- 同意の取り消し・保存期間の削除では、映像と一緒に消す。「(音楽)」などの注記の区間は除く

## 5. 応募書類

- 形式はファイル名・Content-Type ではなく先頭のバイトで判定(PDF・JPEG・PNG・WebP だけ。SVG・HTML は受け付けない)
- 1件 20MB・1面接 20件まで。表示は同じオリジンから `Content-Disposition: inline` + `nosniff`(画面の CSP とは別)
- 削除は添付した本人か管理者。判定から `retention.attachmentDaysAfterDecision` 日で自動削除

## 6. 事前のオンライン同意

- 担当者がリンクを作る(`POST /api/interviews/:id/consent-links`)。トークンは 32 バイトの乱数で、**作成時に1度だけ返す**。サーバーには SHA-256 だけを保存し、応答・書き出しにも出さない
- 公開の入口(ログイン不要): `GET/POST /api/public/consent/:token`。状態は open / done / expired(期限切れ・判定済み)/ revoked
- 送信時は、表示した同意文の版(本文のハッシュ)が今の版と同じか確かめる(説明が変わっていれば読み直してもらう)。未成年は保護者の氏名が必要
- 間違ったトークンを続けて送る接続元は、ログインと同じ試行制限で一時的に止める(キーは接続元ごと。ほかの人の失敗で正しいリンクの人が止まらないように)
- 記録は `ConsentRecord.method = "online"`、`linkId` つき。操作ログに接続元の IP とともに残す

## 7. メールのお知らせ

- SMTP は nodemailer(サーバーのビルドに同梱)。465 番以外は STARTTLS を必須にする
- 宛先は「有効・メールあり・その種類を受け取る設定・その面接を見られる」人だけ(`mailRecipients`)。1人1通ずつ送る(宛先どうしにアドレスを見せない)
- 本文は候補者の表示名・日時・場所・リンクだけ。評価の内容や数値は載せない
- 出来事: ライブ開始(録画している本人を除く)/ 録画の共有(未提出の担当面接官)/ 評価がそろった(管理者)/ 判定の確定(担当面接官)/ オンラインの同意(管理者と送った人)
- 時間がたってから送るもの(`runReminders`、15分ごと): 評価の催促(材料がそろってから設定の時間後、24時間おき・最大3回)と前日のお知らせ(日本時間で設定の時刻以降)。
  1人1通にまとめ、送ったものは `notify-log.json` に記録して二重に送らない(前日のお知らせは日時が変われば送り直す)

## 8. 検索・書き出し

- 検索(`GET /api/search?q=`): 見られる面接を新しい順に調べ、50 件まで。検索は操作ログに記録(検索語つき)
- 書き出し(`GET /api/interviews/:id/export.zip[?scope=applicant]`、管理者): 圧縮なしの ZIP をストリームで書く(`server/zip.ts`)。
  CRC とサイズは中身のあとに書く(データ記述子)、ファイル名は UTF-8。ZIP64 は使わないため 4GB を超えるファイルは除き、除いたものを README に書く。
  送信の合言葉(録画の clientId)・リンクのハッシュは含めない。受け手が切断したら書き出しを止める

## 9. 2段階認証

- TOTP(RFC 6238、SHA1・6桁・30秒)。前後1刻みまで受け付け、使った刻み以前のコードは受け付けない(使い回し防止)
- 設定: 鍵を作る → 認証アプリに登録 → 確認コードが合ったら有効。予備のコード 10 個(ハッシュだけ保存、使うと消える)。有効にしたらほかの端末のログインを解除
- ログイン: パスワードが合うと、セッションの代わりに一時的な合言葉(5分・5回まで)を返し、確認コードか予備のコードでセッションを始める。失敗はログインの試行制限に数える
- 管理者への必須化: オンのあいだ、未設定の管理者は `/api/session` `/api/me…` `/api/logout` 以外を 403 にする(画面はアカウントへ案内)。
  オンにする本人は先に設定済みであること。管理者は他人の2段階認証を解除できる(その人のセッションも消す)

## 10. PWA

- manifest とアイコン(`scripts/make-icons.mjs` で生成)
- サービスワーカーは**画面の移動だけ**を扱い、通信できないときに案内のページを返す。何もキャッシュしない(端末に個人情報を残さない)。API・録画の送信・再生には関与しない

## 11. テスト

`npm test` の主なもの(v0.3 で追加):

| ファイル | 内容 |
|---|---|
| `tests/server-v3.test.ts` | 評価シート・重み付き合計点・v0.2 からの移行・同じ候補者・閲覧範囲・ライブ・面接室へのメッセージ・印刷・通知書 |
| `tests/insights.test.ts` | 表情の比較(面接 ID を返さない・件数が少ないと返さない・年代)・比較一覧の非公開・評価の傾向・CSV |
| `tests/documents.test.ts` | 応募書類(形式の判定・権限・上限・保存期間)・オンライン同意(トークン・版・期限・取り消し・試行制限) |
| `tests/mail.test.ts` | テスト用 SMTP サーバーで、出来事ごとのメール・宛先の絞り込み・催促・前日のお知らせ |
| `tests/search-export.test.ts` | 検索の非公開・閲覧範囲、ZIP の中身と CRC |
| `tests/totp.test.ts` | RFC 6238 の試験値・使い回し・予備のコード・ログインの2段目・必須化・解除 |
| `tests/transcribe.test.ts` | whisper の出力の読み取り(実際の文字起こしは環境変数があるときだけ) |
| `tests/ics.test.ts` | .ics の時刻・特殊文字・折り返し |

`npm run e2e` では、ライブ視聴(映像が進む)・場面のメモ・面接室へのメッセージも実ブラウザで確かめる。
