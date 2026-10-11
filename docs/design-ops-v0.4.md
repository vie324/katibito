# 面接記録(運用版)設計書 v0.4 — オンライン面接(Google Meet)

対象: 開発者・Claude Code。v0.3 の設計([design-ops-v0.3.md](design-ops-v0.3.md))に追加した部分だけを書く。
使い方は [operations.md](operations.md) の「5-2. オンライン面接(Google Meet)」。

---

## 0. v0.4 で足したもの

| 要件 | 対応 | 主なファイル |
|---|---|---|
| 候補者が Google Meet で参加する面接も録画・計測したい | 録画する映像の元に「Google Meet」を追加。Meet のタブを画面の共有で受け取り、タブの音声と面接官のマイクを混ぜて録画する | `src/app/record/media.ts`, `src/app/pages/RecordPage.tsx` |
| 面接に Meet のリンクを持たせたい | 面接の `format`(対面/オンライン)と `meetUrl`。詳細・一覧・予定・メール・.ics・まとめて登録 | `src/shared/meet.ts`, `server/routes/interviews.ts` |
| 画面を見せられない候補者から同意を得たい | 同意のリンクをその場で作って Meet のチャットに貼る(回答を自動で検知)/ 口頭で確認(`verbal`)| `src/app/record/ConsentForm.tsx` |
| Meet のタブを見ている間も計測を止めたくない | 映像のトラックから直接フレームを受け取る(`MediaStreamTrackProcessor`)。ライブの心拍は録画のチャンクでも送る | `src/app/record/analyzers.ts`, `src/app/record/recorder.ts` |
| オンラインと対面の値を混ぜて比べたくない | 表情の比較は、代表の録画の映像の元(`capture`)が同じ面接どうしで行う | `server/routes/insights.ts`, `server/recordings.ts` |

Meet の API(Meet REST API・Meet Media API・アドオン)は使わない。Google Cloud のプロジェクトや OAuth の設定なしで、
どの Google アカウント(無料・Workspace)の Meet でも同じように使えるようにするため。

## 1. データ

| 追加・変更 | 場所 | 補い方(v0.3 までのデータ) |
|---|---|---|
| 面接 `format: "inPerson" \| "online"` | interview.json | `"inPerson"`(`normalizeInterview`) |
| 面接 `meetUrl: string \| null` | interview.json | `null`。文字列なら `normalizeMeetUrl` を通す |
| 録画 `capture: "camera" \| "screen"` | interview.json | `"camera"`。取り込み(`source: "file"`)は常に `camera` |
| 同意 `method` に `"verbal"` | interview.json | — |
| 一覧の項目 `format` `meetUrl`、`consent.method` | API の応答 | — |
| 比較 `ExpressionCompare.capture`、`CompareRow.expressionCapture` | API の応答 | — |

- `meetUrl` は `normalizeMeetUrl`(画面・サーバー共通)で `https://meet.google.com/<abc-defg-hij>` か `…/lookup/<名前>` にそろえる。
  ホストは `meet.google.com` だけ(ポート・ユーザー情報つきは不可)。クエリ(`?authuser=`)と `#` は除く。
  メール・.ics・画面にそのまま載せるため、ほかのサイトのリンクを Meet のリンクとして案内しないようにする
- `format` を省いて `meetUrl` があれば `online`(まとめて登録の「Meet のリンク」列だけでもオンラインになる)。
  対面の面接に、同席する人のための Meet のリンクを付けることもできる
- `verbal` の同意は `format === "online"` の面接だけ受け付ける(対面では画面か紙で取る)
- 既定の同意文に「オンライン面接の場合は、Google Meet の画面と音声を録画します」を足した。
  同意文を保存していない設置では同意文の版(ハッシュ)が変わるため、開いたままの同意のリンクは読み直しになる

## 2. Meet のタブの録画

```
getDisplayMedia(タブ + タブの音声) ─┬─ 映像 ───────────────────────────────┐
                                    └─ タブの音声 ─┐                         ├─ MediaRecorder(WebM・2秒ごと)→ 既存の送信
getUserMedia(マイク、エコー除去あり) ─────────────┴─ AudioContext で混ぜる ─┘
```

- `getDisplayMedia` の指定: `displaySurface: "browser"`(タブを最初に出す)、`selfBrowserSurface: "exclude"`(このアプリのタブを候補に出さない)、
  `suppressLocalAudioPlayback: false`(面接官にも聞こえたまま)、`systemAudio: "exclude"`、`monitorTypeSurfaces: "exclude"`。
  大きさは設定の画質(最小 1280×720)までに縮める
- `CaptureController.setFocusBehavior("no-focus-change")`(Chrome 109+): 共有を始めても Meet のタブへ切り替えない
- 音声: タブの音声(候補者・ほかの参加者)とマイク(録画する面接官)を `MediaStreamAudioDestinationNode` で1本にする。
  それぞれの手前に `AnalyserNode` を置き、準備画面で「Meet の音声」「マイク」を別々に確かめる。
  マイクは Meet の音がスピーカーから出るためエコー除去を有効にする(対面のカメラ録画では無効のまま)
- タブの音声がない(「タブの音声も共有する」がオフ)と録画を始められない。ウィンドウ・画面全体を選んだ場合は注意を出す
- マイクを使えなくても録画はできる(面接官の声が入らない旨を表示)。マイクの切り替えは共有をやり直さずに入れ替える
- 共有が止まった(映像のトラックの `ended`。Chrome の「共有を停止」・Meet のタブを閉じた)とき、録画中ならそこで録画を終えて送る。準備中なら選び直してもらう
- 録画のメタに `capture: "screen"` を付けて送る(`POST /api/interviews/:id/recordings` の `capture`)。確認画面では「Google Meet の画面から録画」

Meet の画面には、ほかの面接官の映像も映る。候補者の追跡(`CandidateTracker`)は対面と同じで、最初に選んだ顔(既定は一番大きな顔)を追う。
面接官3人+候補者が並ぶため、同時に検出する顔の数を 3 → 5 にした(`INTERVIEW_ANALYSIS.MAX_FACES`。顔が少なければ負荷は変わらない)。
候補者を固定表示(ピン留め)にしてもらうと顔が大きく映り、安定する(準備画面の案内と確認の文言で促す)。

## 3. 画面が裏に回っても計測を続ける

対面では録画の画面を表示したままだが、オンライン面接では Meet のタブを見たり操作したりする。
これまでの計測は `requestVideoFrameCallback`(描画に合わせて呼ばれる)だったため、画面が裏に回ると止まり、`hidden` の欠けになっていた。

- `LiveAnalyzer` は、映像のトラックを渡されると `MediaStreamTrackProcessor`(Chrome)でフレームを直接読む。描画と関係なく届くので、裏に回っても計測が続く。
  使えないブラウザ・`VideoFrame` を受け付けない環境(検出が5回続けて失敗)では、従来の video 要素からの計測に切り替える
  (`pausesWhenHidden` が true のときだけ「切り替えた時間は計測されていない」と表示する)。対面のカメラ録画も同じ経路を使う
- トラックは複製して読む(録画・プレビューとは別)。`maxBufferSize: 1` で、計測が追いつかないときは古いフレームを捨てる
- 止めるとき: 読み取りの列にフレームが残ったまま複製を止めると、そのフレームが閉じられずに捨てられる(Chrome の警告)。
  そのため、止める指示のあとに読んだフレームを閉じた直後か、次のフレームを待っている間(タイマー)に複製を止める。
  JavaScript は1本で動くので、タイマーが動くのは読み取りを待っている間(列が空のとき)だけになる
- ライブの心拍(`POST …/live`)は5秒ごとのタイマーに加え、録画のチャンク(`dataavailable`、2秒ごと)でも送る(4秒に1回まで)。
  裏に回ったページのタイマーは間引かれる(5分を超えると1分に1回)が、録画の合図は時間どおりに届くため、ライブが途切れない

## 4. オンライン面接の同意

`ConsentForm` は面接の形式で選択肢を変える。

| 形式 | 選択肢 |
|---|---|
| 対面 | この画面を見せる(`onscreen`)/ 紙(`paper`) |
| オンライン | 同意のリンクを Meet のチャットで送る(既定)/ 口頭で確認(`verbal`)/ 紙 |

- 「同意のリンクを Meet のチャットで送る」: 既存の同意のリンク(`POST /api/interviews/:id/consent-links`、有効期限 1日)を作り、
  チャットに貼る文面(団体名・未成年なら保護者へのお願い・リンク)をコピーできるようにする。
  4秒ごとに面接を読み直し、**画面を開いたときと違う同意の記録**が届いたら次へ進む(事前に送ったリンクへの回答も含む)
- 同意の記録(「録画しない」など)がすでにある面接は、サーバーがリンクを作らないため、リンクの選択肢を出さない(口頭か紙)
- 口頭: 同意文は同じものを表示し(読み上げ・画面の共有用)、聞き取った内容を面接官が入力する。録画の開始後に口頭で確かめ直すよう案内する

## 5. 表示・お知らせ

- 詳細: 「Meet を開く」(新しいタブ、`rel="noopener noreferrer"`)、Meet のリンク、場所(空なら「オンライン(Google Meet)」)。
  一覧・今日の面接・予定・比較一覧に「オンライン」「Meet」の表示
- メール: `interviewLines` に `Google Meet: <リンク>` と場所の表示(`placeLabel`)。前日のお知らせは、オンライン面接があれば録画の手順を一言添える
- .ics: オンラインで場所が空なら `LOCATION` に Meet のリンク。`DESCRIPTION` の先頭に `Google Meet: <リンク>`。題名に「[オンライン]」
- 面接の CSV(管理者)に「形式」の列。記録票の場所も `placeLabel`
- 表情の比較(`/api/interviews/:id/expression-compare`): 比べる面接の映像の元は、計測があれば代表の録画、なければ録画・形式から決め、
  同じ映像の元の面接だけで分布を作る。画面には「これまでのオンライン面接の」と出す。比較一覧は Meet の値に「Meet」を付ける

## 6. テスト

| ファイル | 内容 |
|---|---|
| `tests/meet.test.ts` | Meet のリンクの正規化と拒否(別ホスト・ポート・ユーザー情報・形の違い)、形式とリンクの登録・変更・まとめて登録、口頭の同意はオンラインだけ、`capture`(取り込みはカメラ)、v0.3 のデータの読み込み、.ics |
| `tests/insights.test.ts` | Meet の画面の計測は対面と分けて比べる(件数・形式からの判定・比較一覧の表示) |
| `tests/mail.test.ts` | オンライン面接のメールに場所と Meet のリンク |

`npm run e2e:meet`(要 `npm run build`): 偽の Meet のページを別のタブで開き、**実際のタブの共有**で録画する。

- 共有するタブは `--auto-select-tab-capture-source-by-title=<タイトル>` で選ぶ。`--use-fake-ui-for-media-stream` を付けると
  「このタブ」が共有されてしまうため付けない(マイクの許可は Playwright の permissions で与える)
- ヘッドレスではタブの音声は無音、マイクは `--use-fake-device-for-media-stream` の合成の音
- ヘッドレスの Chromium は、タブの共有を完全に終える(映像と音声の両方を止める・共有中のタブを閉じる・ページを読み込み直す)と
  ブラウザごと落ちる(画面のない環境の不具合。実際の Chrome では起きない)。テストでは、タブの音声のトラックの `stop()` だけを無視し、
  「共有を停止」は映像のトラックに `ended` を起こして再現する。共有のあとは画面の中のリンクで移動する
- 確かめること: Meet のリンクの正規化、同意のリンクへの保護者の回答で自動で撮影の準備へ、Meet のタブ(このアプリではない)が共有されること、
  共有してもアプリの画面のまま、候補者の顔の検出、録画・送信・計測(顔を計測できた時間の割合)、共有が止まったときの自動終了と送信
