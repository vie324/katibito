// ライブ視聴(数秒遅れ): 録画している端末がサーバーへ送った2秒ごとのチャンクを、
// Media Source Extensions でそのまま再生する。途中から見るときは、録画の先頭(初期化部分)に
// 最新に近い Cluster の先頭からつなぐ。見ながら、録画の時刻つきのメモと、面接室へのメッセージを送れる。

import { useEffect, useRef, useState } from "react";
import type { InterviewDetail, RecordingMeta } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatClock } from "../format";
import { useSession } from "../session";
import { Notice, useToast } from "../ui";
import { Watermark, watermarkText } from "./Watermark";

/** Chrome の MediaRecorder が書く Cluster の先頭(ID + サイズ不明)。続く 0xE7 は Timecode */
const CLUSTER_HEAD = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7];

/** バイト列の中の最初の Cluster の先頭。見つからなければ -1 */
export function findClusterStart(buf: Uint8Array, from = 0): number {
  const n = CLUSTER_HEAD.length;
  outer: for (let i = from; i + n <= buf.length; i++) {
    for (let j = 0; j < n; j++) if (buf[i + j] !== CLUSTER_HEAD[j]) continue outer;
    return i;
  }
  return -1;
}

/** "video/webm;codecs=vp8,opus" → 'video/webm; codecs="vp8,opus"'(MSE 用) */
export function mseType(mime: string): string {
  const base = mime.split(";")[0].trim();
  const codecs = /codecs=([^;]+)/i.exec(mime)?.[1]?.replace(/"/g, "").trim();
  return codecs ? `${base}; codecs="${codecs}"` : base;
}

type Phase = "connecting" | "playing" | "unsupported" | "ended" | "error";

/** 受信済みチャンクのうち、0 から連続している最後の番号 */
function lastContiguous(received: number[]): number {
  const set = new Set(received);
  let i = -1;
  while (set.has(i + 1)) i++;
  return i;
}

function LivePlayer({ iid, rec }: { iid: string; rec: RecordingMeta }) {
  const { user, settings } = useSession();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const type = mseType(rec.mimeType);
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(type)) {
      setPhase("unsupported");
      return;
    }
    let alive = true;
    const abort = new AbortController();
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    video.src = url;
    let sb: SourceBuffer | null = null;
    let next = -1; // 次に読むチャンク(-1 = まだ始めていない)
    let started = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const append = (data: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        if (!sb) return reject(new Error("SourceBuffer がありません"));
        const onEnd = () => {
          sb!.removeEventListener("updateend", onEnd);
          sb!.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = () => {
          sb!.removeEventListener("updateend", onEnd);
          sb!.removeEventListener("error", onErr);
          reject(new Error("映像を読み込めません"));
        };
        sb.addEventListener("updateend", onEnd);
        sb.addEventListener("error", onErr);
        sb.appendBuffer(data as BufferSource);
      });

    const chunk = async (i: number) => new Uint8Array(await api.liveChunk(iid, rec.id, i, abort.signal));

    /** 先頭の初期化部分 + 最新に近い Cluster から始める */
    const join = async (last: number) => {
      const first = await chunk(0);
      if (last < 3) {
        await append(first);
        next = 1;
        return;
      }
      const init = findClusterStart(first);
      if (init <= 0) {
        await append(first);
        next = 1;
        return;
      }
      for (let k = last - 1; k >= 1; k--) {
        const buf = await chunk(k);
        const off = findClusterStart(buf);
        if (off < 0) continue;
        await append(first.subarray(0, init));
        await append(buf.subarray(off));
        next = k + 1;
        return;
      }
      await append(first);
      next = 1;
    };

    const keepUp = () => {
      if (!sb || sb.updating || video.buffered.length === 0) return;
      const start = video.buffered.start(0);
      const end = video.buffered.end(video.buffered.length - 1);
      if (!started) {
        started = true;
        video.currentTime = Math.max(start, end - 3);
        void video.play().catch(() => undefined);
        setPhase("playing");
        return;
      }
      // 遅れが大きくなったら(タブを裏にしていた等)最新近くへ戻る
      if (end - video.currentTime > 12) video.currentTime = end - 3;
      // 見終わった部分はメモリから消す
      if (video.currentTime - start > 90) sb.remove(start, video.currentTime - 60);
    };

    const loop = async () => {
      if (!alive) return;
      try {
        const { recording, received } = await api.recording(iid, rec.id);
        if (recording.status !== "uploading") {
          setPhase("ended");
          if (ms.readyState === "open" && sb && !sb.updating) ms.endOfStream();
          return;
        }
        const last = lastContiguous(received);
        if (last >= 0) {
          if (next < 0) await join(last);
          while (alive && next <= last) {
            await append(await chunk(next));
            next++;
          }
          keepUp();
        }
        setError(null);
      } catch (e) {
        if (!alive) return;
        if ((e as Error).name === "QuotaExceededError" && sb && video.buffered.length > 0) {
          sb.remove(video.buffered.start(0), Math.max(video.buffered.start(0) + 1, video.currentTime - 10));
        } else {
          setError(errorMessage(e));
        }
      }
      if (alive) timer = setTimeout(() => void loop(), 2000);
    };

    ms.addEventListener("sourceopen", () => {
      if (!alive) return;
      try {
        sb = ms.addSourceBuffer(type);
        sb.mode = "segments";
      } catch (e) {
        setPhase("error");
        setError(errorMessage(e));
        return;
      }
      void loop();
    });

    return () => {
      alive = false;
      abort.abort();
      if (timer) clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
  }, [iid, rec.id, rec.mimeType, attempt]);

  if (phase === "unsupported") {
    return <Notice kind="info">このブラウザではライブで見られません。パソコンの Chrome / Edge でご覧ください(録画が終われば、どの端末でも再生できます)。</Notice>;
  }
  return (
    <div className="live-stage">
      <div className="live-video">
        <video
          ref={videoRef}
          muted
          playsInline
          controls
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          onContextMenu={(e) => e.preventDefault()}
        />
        {settings?.security.watermark !== false && <Watermark text={watermarkText(user?.name)} />}
        {phase === "connecting" && <div className="preview-cover">接続しています</div>}
        {phase === "ended" && <div className="preview-cover">録画が終わりました。まもなく、ふつうの再生ができるようになります</div>}
      </div>
      {error && (
        <Notice kind="warn">
          ライブの映像を受け取れません: {error}
          <button className="small-btn" onClick={() => setAttempt((x) => x + 1)}>
            つなぎ直す
          </button>
        </Notice>
      )}
      <div className="muted small">音声は最初は消してあります。映像の下のスピーカーのボタンで聞けます。</div>
    </div>
  );
}

/** 録画中の面接: ライブの映像と、見ながらのメモ・面接室へのメッセージ */
export function LivePanel({ detail, setDetail, rec }: { detail: InterviewDetail; setDetail: (d: InterviewDetail) => void; rec: RecordingMeta }) {
  const toast = useToast();
  const iv = detail.interview;
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(rec.live?.elapsedMs ?? 0);

  // 経過時間はサーバーの値から手元で進める
  useEffect(() => {
    const base = rec.live?.elapsedMs ?? 0;
    const t0 = performance.now();
    setElapsed(base);
    const t = setInterval(() => setElapsed(base + (performance.now() - t0)), 1000);
    return () => clearInterval(t);
  }, [rec.live?.elapsedMs]);

  const send = async (kind: "note" | "room") => {
    const text = (kind === "note" ? note : message).trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await api.addNote(iv.id, { recordingId: rec.id, tMs: null, text, kind, live: true });
      setDetail({ ...detail, notes: res.notes });
      if (kind === "note") {
        setNote("");
        toast("この場面にメモを残しました");
      } else {
        setMessage("");
        toast("面接室の録画端末に表示しました");
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel live-panel" id="live">
      <div className="panel-title">
        <span className="live-dot" aria-hidden />
        ライブ(数秒遅れ)
        <span className="num muted">{formatClock(elapsed)}</span>
        {rec.live?.question && <span className="live-q">いまの質問: {rec.live.question}</span>}
      </div>
      <div className="pad live-grid">
        <LivePlayer iid={iv.id} rec={rec} />
        <div className="live-side">
          <div className="form compact">
            <span className="field-label">見ながらメモ</span>
            <textarea
              rows={3}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              placeholder="いまの場面について(録画の時刻と一緒に残ります)"
            />
            <button className="primary" disabled={busy || !note.trim()} onClick={() => void send("note")}>
              この場面にメモ
            </button>
          </div>
          <div className="form compact">
            <span className="field-label">面接室へのメッセージ</span>
            <textarea
              rows={2}
              value={message}
              maxLength={300}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="例: 最後に部活のことを聞いてください"
            />
            <button disabled={busy || !message.trim()} onClick={() => void send("room")}>
              面接室に送る
            </button>
            <span className="muted small">録画している端末の画面に表示されます。評価についての意見は書かないでください(面接官全員に見えます)。</span>
          </div>
        </div>
      </div>
    </section>
  );
}
