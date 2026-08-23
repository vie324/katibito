# AI面接 行動シグナル解析デモ — 設計書 v0.1

対象: Claude Code(初回実装用)
スコープ: 解析エンジンとデモUIのみ。ATS本体は含まない。

---

## 0. この文書の使い方

この文書は Claude Code にそのまま渡す前提で書かれている。
セクション5〜7(シグナル抽出・スコアリング・出力)が仕様の核であり、
ここに書かれた定数はすべて `src/config/` に集約して**あとから差し替え可能**にすること。
現時点の定数はキャリブレーション前の暫定値であり、正解ではない。

---

## 1. ゴールと非ゴール

### ゴール
1. 面接の受け答えをリアルタイムで解析し、「主張性」「感情表出性」の2軸を動く数値として可視化する
2. 録画終了後、4象限への分類と**根拠となった行動指標**を並べて提示する
3. 商談の場で1台のノートPCで動き、**絶対に落ちない**
4. デモを1回実施するたびに、キャリブレーション用のデータが1件貯まる

### 非ゴール
- 合否判定・スコアランキング。UIのどこにも「適性◯点」「推奨/非推奨」を出さない
- 感情の推定(喜怒哀楽の分類)。**この機能は実装しない**
- サーバーサイド、DB、ログイン、ATS連携
- 精度の主張。デモ画面には常に「キャリブレーション前・暫定基準」のラベルを出す

### なぜ「驚き」が出るのか(実装判断の指針)
驚きは精度からは出ない。**応答速度と可視化の生々しさ**から出る。
自分の声と表情に反応してメーターが動く、その体験が主役。
判断に迷ったら「リアルタイム性を守る」側を選ぶこと。

---

## 2. 体験フロー

```
[1] 起動           モデル・WASMのプリロード(進捗バー表示)
       ↓
[2] 環境チェック    5項目のグリーンチェック(後述)
       ↓
[3] 設問セット      3問 × 各60秒。画面に設問、下にカウントダウン
       ↓  ← ここでライブ可視化が走る(デモの主役)
[4] 結果           4象限プロット + 根拠指標テーブル + 接し方ガイド
       ↓
[5] タイムライン    録画を巻き戻し、どの瞬間に何が動いたか確認
       ↓
[6] エクスポート    セッションJSONをダウンロード
```

---

## 3. アーキテクチャ

### 構成
- Vite + React 18 + TypeScript
- **バックエンドなし。** 映像・音声は一切ブラウザ外に出ない
- Vercel に静的デプロイ可能
- 状態管理ライブラリ不要(後述のとおりホットパスは React state を経由しない)

### 依存

| 用途 | 選択 |
|---|---|
| 顔ランドマーク | `@mediapipe/tasks-vision` の `FaceLandmarker` |
| 音声特徴 | Web Audio API(`AnalyserNode`)— 外部ライブラリなし |
| 文字起こし | Web Speech API(`webkitSpeechRecognition`, `lang: 'ja-JP'`) |
| 描画 | Canvas 2D(メッシュ・トレース)+ SVG(メーター) |
| グラフ | 使わない。すべて自前描画(recharts は毎フレーム描画に耐えない) |

### 重要な但し書き — Web Speech API
Chrome の Web Speech API は**音声を Google のサーバーに送信する**。
「映像も音声も端末外に出ません」という説明は、この構成では**できない**。
対応:
- デモ画面の環境チェック欄に「文字起こしに Chrome の音声認識を使用(音声がGoogleに送信されます)」と明示する
- 本番では Whisper を自社エンドポイントに置く前提であることを設計書上に残す
- 音声認識をオフにして表情+音響のみで走るモードも用意する(`ENABLE_SPEECH_RECOGNITION` フラグ)

### モデルのローカル同梱(必須)
商談会場のWi-Fiを信用しない。以下を `public/` に**vendoring すること**。
- `public/models/face_landmarker.task`(float16版, 約3.7MB)
- `public/wasm/`(tasks-vision の WASM 一式)

CDN参照はビルド時のみ。実行時に外部通信が発生しない状態にする。

```ts
const fileset = await FilesetResolver.forVisionTasks("/wasm");
const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "GPU" },
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  runningMode: "VIDEO",
  numFaces: 1,
});
```

---

## 4. 環境チェック(セクション2の[2])

録画開始前に3秒間サンプリングし、5項目を判定する。
**この画面自体がデモの信頼性を演出する**ので、手を抜かないこと。

| 項目 | 合格条件 |
|---|---|
| 顔の検出 | 直近3秒の検出率 ≥ 90% |
| 顔の大きさ | 顔バウンディングボックスの高さが映像高の 25〜55% |
| 正対 | \|yaw\| ≤ 15° かつ \|pitch\| ≤ 15° の frame が 80% 以上 |
| 明るさ | 顔領域の平均輝度が 80〜200(0-255) |
| マイク | 発話時のRMSが閾値以上、かつクリップしていない |

未達の項目には**具体的な直し方**を出す。「明るさが足りません」ではなく
「窓を背にせず、顔の正面に光がくる位置に移動してください」。

**エスケープハッチ(必須)**: 「チェックを無視して開始」ボタンを常に出す。
ライブデモでゲートに阻まれるのが最悪の事故。ただし無視した場合は
結果画面の確信度を強制的に「低」にする。

---

## 5. シグナル抽出仕様

### 5.1 フレームレコード
30fps で以下を ring buffer(60秒 = 1800フレーム)に積む。

```ts
type FrameRecord = {
  t: number;                    // セッション開始からのms
  faceDetected: boolean;
  blendshapes: Float32Array;    // 52要素
  headPose: { yaw: number; pitch: number; roll: number };  // degrees
  rms: number;                  // 0-1
  f0: number | null;            // Hz, 無声時null
  voiced: boolean;              // VAD結果
};
```

### 5.2 表情シグナル
使用する blendshape(ARKit準拠の名前で `categoryName` から引く):

| 特徴量 | 使用blendshape | 定義 |
|---|---|---|
| `smileRate` | `mouthSmileLeft`, `mouthSmileRight` | 平均値 > 0.15 のフレーム比率 |
| `smileIntensity` | 同上 | 上位10%フレームの平均値 |
| `duchenneRatio` | 上記 + `cheekSquintLeft/Right` | 笑顔フレームのうち頬の上がりを伴う比率 |
| `browActivity` | `browInnerUp`, `browOuterUpLeft/Right` | いずれか > 0.20 のフレーム比率 |
| `expressionVariance` | 上記全部の合計値 | 時系列の標準偏差 |
| `blinkRate` | `eyeBlinkLeft/Right` | 0.5超えの立ち上がり回数/分 |

`duchenneRatio` は AU12(口角)と AU6(頬)の共起で「作り笑いか否か」の
古典的な指標。デモで説明すると効く。ただし**確信度は低く扱うこと**。

### 5.3 頭部姿勢
`facialTransformationMatrixes[0].data`(4x4, column-major)の回転部分を
オイラー角に分解する。**符号は実機で必ず検証**すること(うなずいて pitch が
どちらに振れるか目視確認 → 定数 `PITCH_SIGN` で吸収)。

- `nodRate`: pitch の 0.5〜3.0Hz 帯域成分のゼロ交差数 / 分
- `poseStability`: yaw/roll の標準偏差

### 5.4 音響シグナル
`AnalyserNode`(`fftSize: 2048`)から `getFloatTimeDomainData` で取得。

- **RMS**: バッファの二乗平均平方根
- **F0**: 自己相関法。探索範囲 70〜400Hz。ピーク相関が0.3未満なら `null`
- **VAD**: RMS がノイズフロア × 3 を超えたら発話。ヒステリシス(開始閾値 > 終了閾値)と 200ms のハングオーバーを入れる

導出特徴量:

| 特徴量 | 定義 |
|---|---|
| `voicedRatio` | 発話フレーム / 全フレーム |
| `meanPauseMs` | 200ms以上の無声区間の平均長 |
| `f0CV` | F0の変動係数(std / mean)。有声フレームのみ |
| `rmsMean` | 発話時RMSの平均 |
| `responseLatencyMs` | 設問表示 → VAD立ち上がり(300ms継続)までの時間 |

### 5.5 言語シグナル
Web Speech API の `interimResults: true, continuous: true` で逐次取得。
確定結果(`isFinal`)ごとに文として蓄積。文末は「。?!」または確定区切り。

| 特徴量 | 定義 |
|---|---|
| `charPerMin` | 総文字数(空白除く) / 発話秒数 × 60 |
| `hedgeRate` | ヘッジ表現ヒット数 / 文数(付録A) |
| `assertionRate` | 断定表現ヒット数 / 文数(付録A) |
| `fillerRate` | フィラー出現数 / 100文字(付録A) |
| `emotionWordRate` | 感情語出現数 / 100文字(付録A) |
| `firstPersonRate` | 「私」「僕」「自分」の明示数 / 文数 |

---

## 6. スコアリング仕様

### 6.1 正規化
各特徴量を `NORMS` の帯域で 0〜100 に線形マップし、範囲外はクリップ。
`invert: true` の項目は反転させる。

```ts
// src/config/scoring.ts — この値は全部あとで差し替える前提
export const NORMS = {
  // 主張性
  charPerMin:        { low: 240, high: 420, invert: false },
  rmsMean:           { low: 0.02, high: 0.12, invert: false },
  responseLatencyMs: { low: 300, high: 2500, invert: true  },
  meanPauseMs:       { low: 250, high: 900,  invert: true  },
  assertionRate:     { low: 0.10, high: 0.55, invert: false },
  hedgeRate:         { low: 0.10, high: 0.60, invert: true  },
  fillerRate:        { low: 0.5,  high: 4.0,  invert: true  },
  firstPersonRate:   { low: 0.05, high: 0.40, invert: false },
  // 感情表出性
  smileRate:          { low: 0.02, high: 0.35, invert: false },
  smileIntensity:     { low: 0.15, high: 0.60, invert: false },
  browActivity:       { low: 0.03, high: 0.30, invert: false },
  expressionVariance: { low: 0.05, high: 0.35, invert: false },
  nodRate:            { low: 2,    high: 20,   invert: false },
  f0CV:               { low: 0.08, high: 0.30, invert: false },
  emotionWordRate:    { low: 0.2,  high: 3.0,  invert: false },
} as const;
```

**日本語話者の注意**: 上の帯域は欧米データセットの一般値を出発点にした暫定値。
日本人の表情表出量は系統的に小さく、`smileRate` / `browActivity` の `high` は
おそらく高すぎる。デモで自分の顔を入れて振り切れるようなら下げること。

### 6.2 軸スコア

```ts
export const WEIGHTS = {
  assertiveness: {
    charPerMin: 0.18, rmsMean: 0.12, responseLatencyMs: 0.18,
    meanPauseMs: 0.10, assertionRate: 0.15, hedgeRate: 0.15,
    fillerRate: 0.06, firstPersonRate: 0.06,
  },
  expressiveness: {
    smileRate: 0.22, smileIntensity: 0.13, browActivity: 0.12,
    expressionVariance: 0.18, nodRate: 0.12, f0CV: 0.15,
    emotionWordRate: 0.08,
  },
} as const;
```

各軸 = 正規化値の加重平均(0〜100)。重みは各軸で合計1.0。
**言語特徴が取れない場合**(音声認識オフ、認識失敗)は、
言語系の重みをゼロにして残りを再正規化し、確信度を1段下げる。

### 6.3 リアルタイム値 vs 確定値
2つの時定数を持つ。混同しないこと。

- **ライブ値**: EMA(α = 0.15、約2秒の時定数)。メーターの動きに使う。ヌルヌル動くことが最優先
- **確定値**: セッション全体(または設問単位)を集計した値。結果画面に使う

ライブ値はあくまで演出。結果画面で確定値と食い違っても問題ない。
ただし食い違いが極端だとバレるので、確定値は「全区間のライブ値の中央値」ではなく
**生の特徴量から再計算**すること。

### 6.4 4象限

| 主張性 | 表出性 | 名称 | 接し方の骨子 |
|---|---|---|---|
| 高 | 高 | **発信型** | 場を任せる。人前で話す役割を早めに渡す。細かい手順書より目的を伝える |
| 高 | 低 | **決断型** | 結論から話す。雑談を挟まない。裁量と数値目標を渡す |
| 低 | 高 | **協調型** | 承認とフィードバックの頻度を上げる。詰めるより一緒に考える |
| 低 | 低 | **熟考型** | 手順と基準を文書で渡す。即答を求めない。考える時間を明示的に確保する |

名称は独自のもの。既存の商標名(ソーシャルスタイル®等)は**UI・コード・
資料のどこにも使わないこと**。

### 6.5 確信度
以下の最小値を取る。

```ts
confidence = min(
  trackingQuality,      // 顔検出率
  speechCoverage,       // 発話時間 / 30秒 でクリップ
  centerDistance,       // min(|A-50|, |E-50|) / 25 でクリップ
  envGatePassed ? 1.0 : 0.4
)
```

表示は「高 / 中 / 低」の3段階。**数値パーセントは出さない**(実態より
精密に見えるため)。0.66以上=高、0.4以上=中、それ未満=低。

確信度「低」のときは4象限の名称を出さず、「判定に足るデータが
取れていません」と出す。ここで無理に断定しないのが、逆に信頼される。

---

## 7. 出力仕様

結果画面は上から順に:

1. **4象限プロット** — 最終位置と、セッション中の軌跡(減衰トレイル)
2. **判定** — 象限名 + 確信度バッジ + 「キャリブレーション前の暫定判定」注記
3. **根拠テーブル** — 全特徴量の生値・正規化値・寄与度。**畳まずに全部出す**
4. **接し方ガイド** — 3〜4行の運用文
5. **タイムライン** — 録画スクラブ + 各シグナルの時系列グラフ

### 根拠テーブルが最重要
「笑顔 2.1回/分」「発話速度 318字/分」「ヘッジ率 22%」を素で見せる。
ここを畳むと途端に胡散臭くなる。全部見せて人間が検算できる状態にすること。

### 接し方ガイド
デフォルトはテンプレート生成(象限 × 上位2特徴量の組み合わせ表)。
`VITE_ANTHROPIC_API_KEY` が設定されている場合のみ Claude API に投げて
文章生成する。**キー未設定でも必ずテンプレートで動くこと**(デモ会場での
キー不備は致命傷)。

出力に含めてはいけない表現:
- 「採用すべき」「向いていない」等の推奨・非推奨
- 性格の断定(「〜な人です」)→「〜な傾向が観測されました」にする
- 内面・感情への言及(「緊張していた」「自信がなさそう」)

---

## 8. データモデルとエクスポート

**デモツールがそのままキャリブレーション用データ収集ツールになる。**
これが本設計の戦略的な狙い。1回デモするたびにサンプルが1件貯まる。

```ts
type Session = {
  sessionId: string;          // uuid
  recordedAt: string;         // ISO8601
  appVersion: string;
  environment: {
    gatePassed: boolean;
    gateResults: Record<string, boolean>;
    device: string;           // userAgent
    speechRecognitionUsed: boolean;
  };
  questions: {
    questionId: string;
    text: string;
    durationMs: number;
    transcript: string;
    features: Record<string, number | null>;   // 生の特徴量
  }[];
  aggregate: {
    features: Record<string, number | null>;
    assertiveness: number;
    expressiveness: number;
    quadrant: string;
    confidence: "high" | "mid" | "low";
  };
  normsVersion: string;       // どの基準値で算出したか
  groundTruth: null;          // ← 後から他者評価を追記するための枠
};
```

- 「結果をJSONで保存」ボタンでダウンロード
- **映像・音声は含めない**(サイズと個人情報の両面から)
- `normsVersion` を必ず入れる。基準値を差し替えた後も過去データを再計算できるようにするため
- `groundTruth` の枠を最初から用意しておく。あとで他者評価を突き合わせる

---

## 9. パフォーマンス要件

**ここが実装で一番壊れやすい。**

### 絶対ルール
1. **毎フレームのデータを React state に入れない。** `useRef` + `requestAnimationFrame` + Canvas への直接描画
2. 数値表示(メーターの数字)の React 更新は **6Hz**(166ms間隔で ref を読む `setInterval`)
3. `detectForVideo()` は video の `currentTime` ベースのタイムスタンプで呼ぶ。同一タイムスタンプで2回呼ぶと例外が出る
4. ring buffer は `Float32Array` の固定長で確保。配列の `push`/`shift` を使わない
5. メッシュ描画は 478点全部を毎フレーム描かない。輪郭・眉・口・目の代表点のみ(約120点)

### 目標
- MacBook Air (M1相当) で 30fps を維持、CPU 50%以下
- 起動からカメラ映像表示まで 3秒以内(モデルはローカルなので達成可能)
- 60秒録画後、結果画面表示まで 1秒以内

### 落ちない設計

| 障害 | 挙動 |
|---|---|
| カメラ許可拒否 | サンプルセッション再生モードへ(`public/sample-session.json`) |
| モデル読み込み失敗 | 同上 |
| 音声認識が使えない | 言語特徴を無効化して継続。確信度を1段下げる |
| 顔がフレームアウト | 該当フレームを欠測扱い。メーターは最後の値を保持し、画面端に控えめな警告 |
| GPU delegate 失敗 | `delegate: "CPU"` にフォールバック |

**サンプルセッション再生モードは必ず実装すること。** これがあるだけで
デモが失敗しなくなる。実装順序でも早めに置いている。

---

## 10. ファイル構成

```
src/
  main.tsx
  App.tsx
  config/
    scoring.ts          # NORMS, WEIGHTS, 確信度閾値 — チューニングはここだけ
    questions.ts        # 設問セット
    lexicon.ts          # ヘッジ/断定/フィラー/感情語(付録A)
    flags.ts            # ENABLE_SPEECH_RECOGNITION 等
  engine/
    faceEngine.ts       # MediaPipe ラッパ。blendshape + headPose を吐く
    audioEngine.ts      # RMS / F0 / VAD
    speechEngine.ts     # Web Speech API ラッパ
    ringBuffer.ts       # Float32Array ベースの固定長バッファ
    features.ts         # FrameRecord[] → 特徴量
    scoring.ts          # 特徴量 → 2軸 → 象限 → 確信度
    sessionStore.ts     # Session の組み立てとJSON書き出し
  ui/
    EnvGate.tsx
    Stage.tsx           # video + canvas オーバーレイ
    MeshOverlay.tsx
    AxisMeter.tsx       # 2本のメーター
    QuadrantTrace.tsx   # ★シグネチャ要素
    QuestionRunner.tsx
    ResultPanel.tsx
    EvidenceTable.tsx
    Timeline.tsx
  styles/
    tokens.css
public/
  models/face_landmarker.task
  wasm/
  sample-session.json
```

---

## 11. ビジュアル方向性

**コンセプト: 計測器。** AIプロダクトのランディングページではなく、
オシロスコープや音響レベルメーターの系譜。「これは実際に何かを測っている」
と見えることが、そのまま信頼性の演出になる。

### トークン

```css
:root {
  --panel:        #14171C;   /* 冷たいチャコール。純黒にしない */
  --panel-raised: #1C2027;
  --rule:         #2A3038;
  --ink:          #E8E6E1;   /* 暖色寄りの白。冷たい地に暖色文字=計器の質感 */
  --ink-dim:      #8A9099;
  --signal-a:     #E8A33D;   /* ナトリウム灯のアンバー = 主張性 */
  --signal-e:     #4FB3A5;   /* 抑えたティール = 感情表出性 */
}
```

2つのシグナル色は**2軸に対応する**。装飾ではなく情報。この対応を
メーター・トレース・タイムライン・根拠テーブルの全部で一貫させること。

### タイポグラフィ
- 日本語UI: `BIZ UDPGothic`(Google Fonts)。Noto Sans JP は避ける — どの
  プロダクトでも見る顔になっていて、計器の質感が出ない
- 数値: `JetBrains Mono`、`font-variant-numeric: tabular-nums` 必須。
  桁が動いて数字が揺れると安っぽくなる
- **すべての数値は等幅**。メーター、テーブル、タイムライン、例外なし

### シグネチャ要素
**4象限グリッド上を動く光点と、その減衰トレイル。**
直近30秒の軌跡が尾を引いて残り、古いほど薄くなる。
デモで人が声を張ると点が右に動き、笑うと上に動く。これが唯一の「魅せ」。
ここに全部のボールドさを使い、他は静かにする。グラデーション、影、
角丸の多用はしない。罫線は 1px の `--rule` のみ。

### コピー
- センテンスケース。「録画を開始」であって「録画開始する」でも「START」でもない
- エラーは謝らない。何が起きて何をすればいいかだけ書く
- 「AIが分析します」と書かない。「発話速度と表情の動きを測ります」と書く

---

## 12. 実装順序

各ステップの終わりで**単体で動く**こと。途中で止めても何か見せられる状態を保つ。

**Step 1 — カメラとメッシュ(半日)**
カメラ映像 + MediaPipe + メッシュオーバーレイ + blendshape 上位5件の
リアルタイム数値表示。これだけで既に見栄えする。

**Step 2 — 音響とVAD(半日)**
RMS/F0/VAD。波形とF0を画面下に流す。頭部姿勢のオイラー角分解と符号検証も
ここで済ませる。

**Step 3 — サンプル再生モードとエクスポート(半日)**
先に作る。`sample-session.json` を Step 1-2 の出力から生成し、
カメラなしでリプレイできる状態にする。**ここまでで「デモが落ちない」が担保される。**

**Step 4 — 特徴量とスコアリング(1日)**
`features.ts` / `scoring.ts`。まだUIは素のテーブルでよい。
自分と社内数名で録って、数値が直感と合うか検証する。合わなければ
`NORMS` を触る。**ここに一番時間を使う。**

**Step 5 — 音声認識と言語特徴(半日)**
Web Speech API と辞書マッチ。オフでも動くことを確認。

**Step 6 — UIの仕上げ(1〜2日)**
環境チェック、設問ランナー、4象限トレース、結果画面、タイムライン。
セクション11の方向性に従う。

---

## 13. 受入基準

- [ ] ネットワークを切った状態で全機能が動く(音声認識を除く)
- [ ] MacBook Air 相当で 30fps を維持、60秒録画中にフレーム落ちが5%未満
- [ ] カメラを拒否してもサンプル再生モードで最後まで通る
- [ ] 意図的に無表情・小声で受け答えすると、両軸が明確に低い側に振れる
- [ ] 意図的に大きな声で笑顔多めに答えると、両軸が明確に高い側に振れる
- [ ] 上記2条件の軸スコア差がそれぞれ25ポイント以上ある(識別力の最低ライン)
- [ ] 同一人物が同じ条件で2回録って、軸スコアの差が10ポイント以内(再現性)
- [ ] 結果画面に「暫定」「キャリブレーション前」の注記が出ている
- [ ] 出力文に推奨/非推奨・性格の断定・感情への言及が含まれない
- [ ] セッションJSONに `groundTruth: null` の枠と `normsVersion` が入っている
- [ ] `src/config/scoring.ts` を編集するだけで全チューニングが完結する

再現性の項目(同一人物2回で10ポイント以内)が一番落ちやすい。
ここが通らない場合、多くは `NORMS` の帯域が狭すぎて振り切れている。

---

## 14. 実装しないこと

明示的にスコープ外。Claude Code はこれらに手を出さないこと。

- 感情分類(喜怒哀楽)— 意図的に作らない
- 合否スコア、適性点、ランキング
- 複数人の比較機能
- 認証、DB、サーバーサイド
- 映像・音声のアップロードや保存
- ATS本体(求人管理、応募者管理、日程調整)
- 年齢・性別・その他属性の推定
- モバイル対応(デスクトップChrome専用でよい)

---

## 付録A: 語彙辞書

`src/config/lexicon.ts` に配置。文字列配列で持ち、正規表現は実行時に生成。

### ヘッジ表現(主張性を下げる)
```
かなと思います / と思います / と思うんですけど / ような気がします / 気がします
たぶん / おそらく / かもしれません / かもしれない / のような / 的な
一応 / なんか / ちょっと / まあ / だったりします / みたいな / 感じです
ではないかと / と考えられます / でしょうか
```

### 断定表現(主張性を上げる)
```
です / ます / でした / ました        ← 文末が言い切りで終わる場合のみカウント
と考えています / と判断しました / 必ず / 確実に / 断言 / 間違いなく
べきです / が重要です / を徹底しました / しています / やりました / 決めました
```

### フィラー
```
えー / えっと / あのー / そのー / んー / なんか / まあ / ですね
```

### 感情語(表出性を上げる)
```
嬉しい / 楽しい / 好き / 大好き / ワクワク / 感動 / 感激 / 面白い
悔しい / 残念 / つらい / 不安 / 心配
すごく / めちゃくちゃ / 本当に / とても / かなり / 圧倒的に
```

### 実装上の注意
- 「ちょっと」「まあ」「なんか」は**ヘッジとフィラーの両方に出現する**。
  重複カウントを避けるため、フィラー判定を先に行い、
  文中の独立した挿入(前後が読点または文頭)ならフィラー、
  修飾語として機能していればヘッジ、とする。判定が難しければ
  **フィラー側に倒す**(保守的な方)
- 断定表現の「です/ます」は文末のみ。文中の「ですね」等は拾わない
- 音声認識の誤変換で辞書がヒットしないケースが必ず出る。
  ヒット数が異常に少ない(文数の5%未満)場合は言語特徴の信頼度を下げる

---

## 付録B: 実装前に確認すべき3点

1. **頭部姿勢の符号** — うなずいたとき pitch が正負どちらに動くか実機確認。
   `PITCH_SIGN` 定数で吸収する
2. **blendshape の名前** — MediaPipe のバージョンで `categoryName` の表記が
   変わることがある。起動時に全52件をコンソールに出して実際の名前を確認する
3. **F0の妥当性** — 自己相関法は倍音でオクターブエラーを起こす。
   男性話者で急に2倍の値が出るようなら、探索範囲を狭めるか
   ピーク選択に閾値を入れる
