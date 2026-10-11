// カメラ・マイクの取得と、選んだ機器の記憶(この端末だけ)。

export type DeviceChoice = { videoId: string | null; audioId: string | null };

const KEY = "katibito.devices";

export function loadDeviceChoice(): DeviceChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v === "object") return { videoId: v.videoId ?? null, audioId: v.audioId ?? null };
  } catch {
    // 保存できない環境でも既定の機器で動く
  }
  return { videoId: null, audioId: null };
}

export function saveDeviceChoice(c: DeviceChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // 無視
  }
}

export async function listDevices(): Promise<{ videos: MediaDeviceInfo[]; audios: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    videos: all.filter((d) => d.kind === "videoinput"),
    audios: all.filter((d) => d.kind === "audioinput"),
  };
}

/**
 * 面接室の録画向けの設定。
 * - 面接官の声と候補者の声の音量差をならすため、自動音量調整・ノイズ抑制は有効
 * - スピーカーから音を出さないのでエコー除去は不要
 */
export async function openCamera(choice: DeviceChoice, quality: { width: number; height: number }): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: quality.width },
    height: { ideal: quality.height },
    frameRate: { ideal: 30, max: 30 },
  };
  if (choice.videoId) video.deviceId = { exact: choice.videoId };
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (choice.audioId) audio.deviceId = { exact: choice.audioId };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (e) {
    // 選んでいた機器が外されている等: 既定の機器でやり直す
    if ((e as DOMException).name === "OverconstrainedError" || (e as DOMException).name === "NotFoundError") {
      return navigator.mediaDevices.getUserMedia({
        video: { width: video.width, height: video.height, frameRate: video.frameRate },
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
    }
    throw e;
  }
}

export function cameraErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "カメラ・マイクの使用が許可されていません。アドレスバーのカメラのアイコンから許可してください";
  }
  if (name === "NotFoundError") return "カメラまたはマイクが見つかりません。接続を確認してください";
  if (name === "NotReadableError") return "カメラが他のアプリで使用中です。ビデオ会議アプリなどを終了してください";
  if (!window.isSecureContext) return "カメラを使うには https で開く必要があります";
  return `カメラを開けません(${(e as Error)?.message ?? name ?? "不明なエラー"})`;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// オンライン面接(Google Meet): Meet のタブを画面の共有で受け取り、
// タブの音声(候補者・ほかの参加者の声)と面接官のマイクを混ぜて録画する
// ---------------------------------------------------------------------------

/** 画面の共有の操作(Chrome 109 以降)。共有を始めても共有したタブへ画面を切り替えないために使う */
type CaptureControllerLike = { setFocusBehavior?: (b: "focus-captured-surface" | "no-focus-change") => void };

export type ScreenCapture = {
  /** 録画する映像と音声(共有したタブの映像 + タブの音声とマイクを混ぜた音声) */
  stream: MediaStream;
  /** 共有したもの(browser = タブ / window = ウィンドウ / monitor = 画面全体) */
  surface: string | null;
  /** タブの音声が共有されているか(「タブの音声も共有する」がオフだと共有されない) */
  hasTabAudio: boolean;
  hasMic: boolean;
  micError: string | null;
  /** 音量(RMS)。その音声がなければ null */
  levels(): { tab: number | null; mic: number | null };
  /** マイクを切り替える(共有はそのまま) */
  replaceMic(audioId: string | null): Promise<void>;
  /** 共有が止められた(Chrome の「共有を停止」・Meet のタブを閉じた など) */
  onEnded: (() => void) | null;
  close(): void;
};

/** オンライン面接の面接官のマイク。Meet の音声がスピーカーから出るため、エコー除去を有効にする */
async function openMic(audioId: string | null): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (audioId) audio.deviceId = { exact: audioId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (e) {
    const name = (e as DOMException).name;
    if (audioId && (name === "OverconstrainedError" || name === "NotFoundError")) {
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    }
    throw e;
  }
}

function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "マイクの使用が許可されていません。面接官の声は録音されません(アドレスバーのアイコンから許可できます)";
  }
  if (name === "NotFoundError") return "マイクが見つかりません。面接官の声は録音されません";
  return `マイクを使えません(${(e as Error)?.message ?? name ?? "不明なエラー"})。面接官の声は録音されません`;
}

function rmsOf(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/**
 * Meet のタブを選んでもらい、録画用のストリームを作る。ボタンを押した処理の中から呼ぶこと
 * (画面の共有はユーザーの操作が必要)。共有を選ばずに閉じた場合は NotAllowedError。
 */
export async function openScreenCapture(audioId: string | null, quality: { width: number; height: number }): Promise<ScreenCapture> {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) throw new DOMException("画面の共有に対応していません", "NotSupportedError");
  const Ctl = (window as unknown as { CaptureController?: new () => CaptureControllerLike }).CaptureController;
  const controller = Ctl ? new Ctl() : undefined;
  const display = await md.getDisplayMedia({
    video: {
      displaySurface: "browser",
      width: { max: Math.max(1280, quality.width) },
      height: { max: Math.max(720, quality.height) },
      frameRate: { ideal: 30, max: 30 },
    },
    // 共有したタブの音は、面接官にもそのまま聞こえるようにする
    audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // 共有の候補にこのアプリのタブを出さない(自分の画面を録らないように)。タブを最初に表示する
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
    surfaceSwitching: "include",
    systemAudio: "exclude",
    monitorTypeSurfaces: "exclude",
    controller,
  } as DisplayMediaStreamOptions);
  // 共有を始めても Meet のタブへ切り替えない(この画面で録画を操作するため)
  try {
    controller?.setFocusBehavior?.("no-focus-change");
  } catch {
    // 対応していない・時間切れ: 切り替わっても録画はできる
  }

  const videoTrack = display.getVideoTracks()[0];
  const tabTrack = display.getAudioTracks()[0] ?? null;
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const buf = new Float32Array(1024);
  const tap = (track: MediaStreamTrack) => {
    const src = ac.createMediaStreamSource(new MediaStream([track]));
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    src.connect(dest);
    return { src, an };
  };
  const tab = tabTrack ? tap(tabTrack) : null;

  let mic: MediaStream | null = null;
  let micNode: { src: MediaStreamAudioSourceNode; an: AnalyserNode } | null = null;
  let micError: string | null = null;
  try {
    mic = await openMic(audioId);
    const t = mic.getAudioTracks()[0];
    if (t) micNode = tap(t);
  } catch (e) {
    micError = micErrorMessage(e);
  }
  if (ac.state === "suspended") await ac.resume().catch(() => undefined);

  const stream = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);
  let closed = false;
  const capture: ScreenCapture = {
    stream,
    surface: (videoTrack.getSettings() as { displaySurface?: string }).displaySurface ?? null,
    hasTabAudio: tab !== null,
    hasMic: micNode !== null,
    micError,
    levels: () => ({ tab: tab ? rmsOf(tab.an, buf) : null, mic: micNode ? rmsOf(micNode.an, buf) : null }),
    async replaceMic(id) {
      const next = await openMic(id).catch((e) => {
        capture.micError = micErrorMessage(e);
        return null;
      });
      if (closed) {
        stopStream(next);
        return;
      }
      micNode?.src.disconnect();
      stopStream(mic);
      mic = next;
      micNode = null;
      const t = next?.getAudioTracks()[0];
      if (t) {
        micNode = tap(t);
        capture.micError = null;
      }
      capture.hasMic = micNode !== null;
    },
    onEnded: null,
    close() {
      if (closed) return;
      closed = true;
      stopStream(display);
      stopStream(mic);
      stopStream(stream);
      void ac.close().catch(() => undefined);
    },
  };
  videoTrack.addEventListener("ended", () => {
    if (!closed) capture.onEnded?.();
  });
  return capture;
}

/** 画面の共有を始められなかったときの案内。選ばずに閉じた(キャンセル)ときは null */
export function screenErrorMessage(e: unknown): string | null {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return null;
  if (name === "NotSupportedError" || name === "TypeError") {
    return "このブラウザは画面の共有(タブの録画)に対応していません。パソコンの Chrome か Edge をお使いください";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "画面または音声を取得できません。Meet のタブを開き直すか、Chrome を再起動してからもう一度お試しください";
  }
  if (!window.isSecureContext) return "画面の共有を使うには https で開く必要があります";
  return `画面の共有を始められません(${(e as Error)?.message ?? name ?? "不明なエラー"})`;
}
