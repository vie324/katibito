# 面接記録 — 録画・表情の計測・合議での判定

面接官3人 × 候補者1人の対面面接を、**同意を得て録画**し、その場にいない担当者も含めて
**録画・表情の計測・面接官の評価**を見ながら判定するための運用アプリです。

- 同意の取得(本人・保護者、録画と表情の計測を別々に)→ 録画 → 自動送信 → 確認 → 評価 → 判定
- 表情の計測は録画中にブラウザ内で行い、注目シーン・質問ごとの集計・タイムラインとして表示
- 面接官の評価は「自分が提出するまで他の人の評価が見えない」方式
- **合否は人が決めます。** 表情の計測は参考資料で、合否スコアや感情・性格の推定は行いません
- 自前のサーバー(Node.js 22、Docker 可)にデータを集約。外部サービスに映像を送りません

使い方・設置・データの扱いは **[運用ガイド](docs/operations.md)**、技術的な設計は **[設計書 v0.2](docs/design-ops-v0.2.md)**。
紙の同意書のひな形は [docs/consent-form.md](docs/consent-form.md)。

商談用の「行動シグナル解析デモ」(v0.1)は `/demo` に残しています(下記)。

## すぐに試す

```bash
npm ci
npm run build
npm start                 # http://localhost:8787 (起動ログに「初期設定コード」が出る)
```

開発時は `npm run dev`(API サーバーと Vite を同時に起動。画面は http://localhost:5173、データは `data-dev/`)。

本番は Docker + Caddy(HTTPS 自動)で設置します:

```bash
cd deploy && cp .env.example .env    # DOMAIN を設定
docker compose up -d --build
docker compose logs app              # 初期設定コード
```

## 検証

```bash
npm test          # 単体・結合テスト(集計・候補者の追跡・WebM 索引付け・サーバー API の全工程・デモのエンジン)
npm run e2e       # 実ブラウザで運用の全工程(要 npm run build)。スクリーンショットは e2e-out/
npm run e2e:upload  # 録画の送信の回復(データの欠け・サーバー側の失敗)を実ブラウザで確認
npm run smoke     # デモ(/demo)のスモークテスト
npm run typecheck
```

`npm run e2e` は合成カメラに MediaPipe のテスト画像の顔を映して、録画 → 送信 → Cues 付き再生 →
表情の計測(笑顔の場面・顔が映っていない区間の検出)→ 非公開ルール付きの評価 → 判定 → 動画の取り込み、までを確認します。

## 構成

```
server/            API サーバー(node:http、依存なし)。認証・面接・録画の受信と索引付け・評価・判定・保存期間・操作ログ
src/app/           運用画面(一覧・登録・撮影・確認・評価・判定・設定)
src/app/record/    録画(MediaRecorder → IndexedDB → 送信)、表情の計測、同意フォーム
src/app/detail/    確認画面(タイムライン・注目シーン・質問ごと・要約・評価・判定)
src/analysis/      顔トラック形式・候補者の追跡・表情の集計・タイムライン系列(サーバーとクライアントで共有)
src/shared/        型・入力検証・同意文・状態の導出(共有)
src/engine/        MediaPipe・音響・特徴量・採点(デモと共有)
src/config/        しきい値・基準値(scoring.ts の INTERVIEW_ANALYSIS が運用版の集計設定)
src/demo/          行動シグナル解析デモ(/demo)
deploy/            docker-compose + Caddyfile
docs/              運用ガイド・設計書・同意書のひな形
tests/             テスト(fixtures/ に Chromium の録画の実出力)
scripts/           e2e・スモーク・素材の同梱・開発サーバー
```

## チューニング

運用版の表情の集計は `src/config/scoring.ts` の `INTERVIEW_ANALYSIS` と、デモと共有の `SIGNAL`(笑顔・眉のしきい値)・
`NORMS`(暫定基準)で決まります。**集計に効く値を変えたら `INTERVIEW_ANALYSIS.VERSION` を上げてください。**
サーバーは保存済みの顔トラックから自動で集計し直します(録画をやり直す必要はありません)。

## 実機で確認する3点

1. **頭部姿勢の符号** — うなずいて pitch が正に振れるか(逆なら `SIGNS.PITCH_SIGN = -1`)。「下を向いていた割合」の向きに効く
2. **blendshape の名前** — 初回の検出時に全52件がコンソールに出る。未知名の警告がないか(`src/engine/blendshapeNames.ts`)
3. **解析レート** — 確認画面の要約に「毎秒◯回」と出る。15回前後が目安

---

## 行動シグナル解析デモ(`/demo`)

面接の受け答えから「主張性」「感情表出性」の2軸をリアルタイムに可視化し、4象限と根拠となった行動指標を示す
商談用デモです。設計書は [docs/design-v0.1.md](docs/design-v0.1.md)。ログイン・サーバーなしで動きます
(`npm run build` 後の `dist/` を静的配信しても `/demo` は動作します)。

- 映像・表情・音響の解析は端末内。モデル・WASM・フォントはローカル同梱
- 合否判定・感情分類・属性推定はしない
- 文字起こしに Chrome の Web Speech API を使う場合、**音声が Google のサーバーに送信される**(環境チェック画面で明示・オフ可)
- 接し方ガイドは既定でテンプレート生成。ビルド時に `VITE_ANTHROPIC_API_KEY` を設定した場合のみ Claude API を試す
  (ブラウザにキーが埋まるため、デモ端末以外に配布するビルドでは設定しないこと。運用版の画面の CSP では外部通信を許可していない)

### デモのチューニング

`src/config/scoring.ts` の `NORMS`・`WEIGHTS`・`SIGNAL`・`SIGNS`・`GATE`・`CONFIDENCE`・`LIVE`。帯域を変えたら `NORMS_VERSION` を上げる。
デモ1回ごとに「結果をJSONで保存」でキャリブレーション用データが1件たまる(`groundTruth` に他者評価を追記する)。
サンプル再生用の `public/sample-session.json` は `npm run generate:sample` で再生成できる。

### モデル・WASM の同梱

- `public/models/face_landmarker.task`(3.7MB)はコミット済み
- `public/wasm/` は `npm run vendor`(dev/build 前に自動実行)で `node_modules/@mediapipe/tasks-vision/wasm` からコピーされる
