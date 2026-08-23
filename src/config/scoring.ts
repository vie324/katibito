// ============================================================================
// チューニングはこのファイルだけで完結させる(設計書 §13)。
// ここにある値はすべてキャリブレーション前の暫定値であり、正解ではない(§0)。
// 値を差し替えたら NORMS_VERSION を必ず上げること — 過去のセッションJSONを
// どの基準で算出したか追跡できなくなる。
// ============================================================================

/** どの基準値でスコアを算出したか。セッションJSONに常に記録される(§8)。 */
export const NORMS_VERSION = "v0.1-precal-20260823";

// ----------------------------------------------------------------------------
// 6.1 正規化帯域
// 各特徴量を low〜high で 0〜100 に線形マップし、範囲外はクリップ。
// invert: true は反転(値が小さいほどスコアが高い)。
//
// 日本語話者の注意(§6.1): この帯域は欧米データの一般値を出発点にした暫定値。
// 日本人の表情表出量は系統的に小さく、smileRate / browActivity の high は
// おそらく高すぎる。自分の顔で振り切れないようなら下げる。
// ----------------------------------------------------------------------------
export const NORMS = {
  // 主張性
  charPerMin:        { low: 240,  high: 420,  invert: false },
  rmsMean:           { low: 0.02, high: 0.12, invert: false },
  responseLatencyMs: { low: 300,  high: 2500, invert: true  },
  meanPauseMs:       { low: 250,  high: 900,  invert: true  },
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

export type ScoredFeatureKey = keyof typeof NORMS;

// ----------------------------------------------------------------------------
// 6.2 軸の重み(各軸で合計 1.0)
// 言語特徴が取れない場合は該当キーの重みをゼロにして残りを再正規化する。
// ----------------------------------------------------------------------------
export type Axis = "assertiveness" | "expressiveness";

export const WEIGHTS: Record<Axis, Partial<Record<ScoredFeatureKey, number>>> = {
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
};

/** 言語系(音声認識由来)の特徴量。認識オフ・失敗時に重みゼロで再正規化する対象。 */
export const LANGUAGE_FEATURES: ScoredFeatureKey[] = [
  "charPerMin", "assertionRate", "hedgeRate", "fillerRate",
  "firstPersonRate", "emotionWordRate",
];

/** 辞書マッチ由来の特徴量。ヒット数が異常に少ない場合(付録A)に除外する対象。 */
export const LEXICON_FEATURES: ScoredFeatureKey[] = [
  "assertionRate", "hedgeRate", "fillerRate", "emotionWordRate",
];

// ----------------------------------------------------------------------------
// 6.4 4象限
// 名称は独自のもの。既存の商標名(ソーシャルスタイル®等)は使わない。
// ----------------------------------------------------------------------------
export type QuadrantKey = "sender" | "decider" | "harmonizer" | "thinker";

export const QUADRANTS: Record<
  QuadrantKey,
  { name: string; assertHigh: boolean; expressHigh: boolean }
> = {
  sender:     { name: "発信型", assertHigh: true,  expressHigh: true  },
  decider:    { name: "決断型", assertHigh: true,  expressHigh: false },
  harmonizer: { name: "協調型", assertHigh: false, expressHigh: true  },
  thinker:    { name: "熟考型", assertHigh: false, expressHigh: false },
};

// ----------------------------------------------------------------------------
// 6.5 確信度
// min() を取る。表示は 高/中/低 の3段階のみ。数値パーセントは出さない。
// ----------------------------------------------------------------------------
export const CONFIDENCE = {
  /** これ以上で「高」 */
  HIGH_MIN: 0.66,
  /** これ以上で「中」。未満は「低」 */
  MID_MIN: 0.4,
  /** speechCoverage = 発話秒数 / この値 でクリップ */
  SPEECH_FULL_SEC: 30,
  /** centerDistance = min(|A-50|, |E-50|) / この値 でクリップ */
  CENTER_FULL_PT: 25,
  /** 環境チェック不合格のまま開始した場合に min() に入る係数 */
  GATE_FAIL_FACTOR: 0.4,
} as const;

// ----------------------------------------------------------------------------
// 6.3 ライブ値(演出用)。確定値は生の特徴量から再計算する。
// ----------------------------------------------------------------------------
export const LIVE = {
  /** EMA 係数。UPDATE_MS と合わせて約2秒の時定数(τ ≈ UPDATE_MS / α) */
  EMA_ALPHA: 0.15,
  /** ライブ軸値の更新間隔 */
  UPDATE_MS: 250,
  /** ライブ特徴量を計算するスライディング窓 */
  WINDOW_MS: 10_000,
  /** 4象限トレイルの保持時間(§11 シグネチャ要素: 直近30秒) */
  TRAIL_SEC: 30,
  /** トレイルのサンプリングレート(Hz) */
  TRAIL_HZ: 10,
  /** 数値表示(React/DOMテキスト)の更新レート(§9: 6Hz) */
  METER_TEXT_HZ: 6,
} as const;

// ----------------------------------------------------------------------------
// 5章 シグナル抽出の閾値
// ----------------------------------------------------------------------------
export const SIGNAL = {
  /** ring buffer 長(秒)。設問60秒+マージン */
  RING_SECONDS: 70,
  /** フレームレート想定 */
  FPS: 30,

  // 5.2 表情
  /** smileRate: mouthSmileLeft/Right 平均がこれを超えたら笑顔フレーム */
  SMILE_ON: 0.15,
  /** duchenneRatio: cheekSquintLeft/Right 平均がこれを超えたら頬の上がりあり */
  CHEEK_ON: 0.10,
  /** browActivity: browInnerUp / browOuterUpLeft/Right のいずれかがこれ超え */
  BROW_ON: 0.20,
  /** blinkRate: eyeBlink 平均のこの値超えの立ち上がりをカウント */
  BLINK_ON: 0.5,
  /** smileIntensity: 上位この割合のフレーム平均 */
  SMILE_TOP_FRACTION: 0.10,

  // 5.3 頭部姿勢
  /** nodRate: pitch のこの帯域(Hz)成分のゼロ交差を数える */
  NOD_BAND_LOW_HZ: 0.5,
  NOD_BAND_HIGH_HZ: 3.0,
  /** ノイズをうなずきに数えないための最小振幅(度) */
  NOD_MIN_DEG: 0.6,

  // 5.4 音響
  /** VAD 開始閾値 = ノイズフロア × この係数(開始 > 終了のヒステリシス) */
  VAD_START_MULT: 3.0,
  /** VAD 終了閾値 = ノイズフロア × この係数 */
  VAD_END_MULT: 2.0,
  /** 終了閾値を下回ってから発話終了と判定するまでのハングオーバー(ms) */
  VAD_HANGOVER_MS: 200,
  /** ノイズフロアが極端に低い環境で誤検出しないための絶対下限 */
  VAD_ABS_MIN_RMS: 0.004,
  NOISE_FLOOR_INIT: 0.003,
  NOISE_FLOOR_MIN: 0.0005,
  NOISE_FLOOR_MAX: 0.05,

  /** F0 自己相関の探索範囲(Hz)とピーク相関の下限 */
  F0_MIN_HZ: 70,
  F0_MAX_HZ: 400,
  F0_MIN_CORR: 0.3,
  /** オクターブエラー対策(付録B): 相関の最大値 × この割合以上の
   *  最初(最小ラグ側)の局所ピークを基本周期として採用する */
  F0_OCTAVE_TOL: 0.9,

  /** meanPauseMs: この長さ以上の無声区間をポーズとして数える */
  PAUSE_MIN_MS: 200,
  /** responseLatencyMs: VAD がこの時間連続で立ってから発話開始とみなす */
  RESPONSE_SUSTAIN_MS: 300,

  // 5.5 言語
  /** 総文字数がこれ未満なら言語特徴を無効化(認識失敗扱い) */
  MIN_TRANSCRIPT_CHARS: 20,
  /** (ヘッジ+断定ヒット数)/文数 がこれ未満なら辞書特徴を除外(付録A: 誤変換対策) */
  LEXICON_MIN_HIT_RATE: 0.05,
  /** f0CV に必要な最小有声フレーム数 */
  F0_MIN_SAMPLES: 30,
} as const;

// ----------------------------------------------------------------------------
// 5.3 / 付録B-1: 頭部姿勢の符号
// うなずいたとき pitch が正になるように実機で目視確認して合わせる。
// MediaPipe のバージョンやカメラのミラー設定で反転することがある。
// ----------------------------------------------------------------------------
export const SIGNS = {
  PITCH_SIGN: 1 as 1 | -1,
  YAW_SIGN: 1 as 1 | -1,
  ROLL_SIGN: 1 as 1 | -1,
};

// ----------------------------------------------------------------------------
// 4章 環境チェックの合格条件
// ----------------------------------------------------------------------------
export const GATE = {
  /** 判定に使うサンプリング時間(秒) */
  SAMPLE_SECONDS: 3,
  /** 顔の検出: 直近サンプルの検出率 */
  DETECT_MIN_RATE: 0.9,
  /** 顔の大きさ: バウンディングボックス高さ / 映像高 */
  FACE_H_MIN: 0.25,
  FACE_H_MAX: 0.55,
  /** 正対: |yaw| と |pitch| がこの角度以内のフレームが POSE_MIN_RATE 以上 */
  POSE_MAX_DEG: 15,
  POSE_MIN_RATE: 0.8,
  /** 明るさ: 顔領域の平均輝度(0-255) */
  LUMA_MIN: 80,
  LUMA_MAX: 200,
  /** マイク: 発話時 RMS の下限と、クリップ判定のピーク値 */
  MIC_MIN_RMS: 0.02,
  MIC_CLIP_PEAK: 0.985,
} as const;

// ----------------------------------------------------------------------------
// 表示用メタデータ(根拠テーブル・タイムラインの表記)
// ----------------------------------------------------------------------------
export type ReferenceFeatureKey =
  | "duchenneRatio" | "blinkRate" | "voicedRatio" | "poseStability" | "meanF0";

export type FeatureKey = ScoredFeatureKey | ReferenceFeatureKey;

type FeatureMeta = {
  label: string;
  unit: string;
  /** percent: 0-1 を % 表示。それ以外はそのまま */
  kind: "percent" | "number";
  digits: number;
  /** どの軸に効くか。reference は採点に使わない参考値 */
  axis: Axis | "reference";
};

export const FEATURE_META: Record<FeatureKey, FeatureMeta> = {
  // 主張性
  charPerMin:        { label: "発話速度",       unit: "字/分",   kind: "number",  digits: 0, axis: "assertiveness" },
  rmsMean:           { label: "声量 (平均RMS)", unit: "",        kind: "number",  digits: 3, axis: "assertiveness" },
  responseLatencyMs: { label: "応答潜時",       unit: "ms",      kind: "number",  digits: 0, axis: "assertiveness" },
  meanPauseMs:       { label: "平均ポーズ長",   unit: "ms",      kind: "number",  digits: 0, axis: "assertiveness" },
  assertionRate:     { label: "断定率",         unit: "/文",     kind: "number",  digits: 2, axis: "assertiveness" },
  hedgeRate:         { label: "ヘッジ率",       unit: "/文",     kind: "number",  digits: 2, axis: "assertiveness" },
  fillerRate:        { label: "フィラー率",     unit: "/100字",  kind: "number",  digits: 1, axis: "assertiveness" },
  firstPersonRate:   { label: "一人称率",       unit: "/文",     kind: "number",  digits: 2, axis: "assertiveness" },
  // 感情表出性
  smileRate:          { label: "笑顔頻度",           unit: "%フレーム", kind: "percent", digits: 1, axis: "expressiveness" },
  smileIntensity:     { label: "笑顔強度 (上位10%)", unit: "",          kind: "number",  digits: 2, axis: "expressiveness" },
  browActivity:       { label: "眉の動き",           unit: "%フレーム", kind: "percent", digits: 1, axis: "expressiveness" },
  expressionVariance: { label: "表情変動 (σ)",       unit: "",          kind: "number",  digits: 3, axis: "expressiveness" },
  nodRate:            { label: "うなずき指標",       unit: "回/分",     kind: "number",  digits: 1, axis: "expressiveness" },
  f0CV:               { label: "声の抑揚 (F0変動)",  unit: "",          kind: "number",  digits: 2, axis: "expressiveness" },
  emotionWordRate:    { label: "感情語率",           unit: "/100字",    kind: "number",  digits: 1, axis: "expressiveness" },
  // 参考値(採点対象外)
  duchenneRatio: { label: "デュシェンヌ比率", unit: "%笑顔中", kind: "percent", digits: 0, axis: "reference" },
  blinkRate:     { label: "まばたき頻度",     unit: "回/分",   kind: "number",  digits: 1, axis: "reference" },
  voicedRatio:   { label: "発話比率",         unit: "%",       kind: "percent", digits: 0, axis: "reference" },
  poseStability: { label: "頭部変動 (σ)",     unit: "°",       kind: "number",  digits: 1, axis: "reference" },
  meanF0:        { label: "基本周波数",       unit: "Hz",      kind: "number",  digits: 0, axis: "reference" },
};
