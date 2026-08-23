// 機能フラグと実行環境まわりの定数。チューニング値は scoring.ts へ。

export const FLAGS = {
  /** 文字起こし(Web Speech API)を使うか。Chrome は音声を Google のサーバーに送信する点に注意。
   *  環境チェック画面のトグルで実行時にも切り替えられる(こちらは初期値)。 */
  ENABLE_SPEECH_RECOGNITION: true,

  /** MediaPipe の GPU delegate を試すか。失敗時は自動で CPU にフォールバックする。 */
  ENABLE_GPU_DELEGATE: true,

  /** メッシュオーバーレイの描画 */
  DRAW_MESH: true,

  /** 結果画面に「リプレイ用データを保存(開発用)」を出すか。
   *  sample-session.json を実データから再生成するときに使う。 */
  ENABLE_REPLAY_EXPORT: true,
} as const;

export const APP_VERSION = "0.1.0";

/** カメラ・マイクの取得条件。
 *  autoGainControl は必ず false — AGC が効くと声量(rmsMean)が計測にならない。
 *  noiseSuppression / echoCancellation も生の信号を優先して切る。 */
export const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "user",
    width: { ideal: 960 },
    height: { ideal: 540 },
    frameRate: { ideal: 30 },
  },
  audio: {
    autoGainControl: false,
    noiseSuppression: false,
    echoCancellation: false,
  },
};

/** ローカル同梱アセットのパス(設計書 §3: 実行時に外部通信を発生させない) */
export const ASSET_PATHS = {
  WASM_DIR: "/wasm",
  FACE_MODEL: "/models/face_landmarker.task",
  SAMPLE_SESSION: "/sample-session.json",
} as const;
