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
