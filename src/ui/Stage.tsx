// video + canvas オーバーレイ(§10)。ミラー表示。
// 顔フレームアウト時は控えめな警告を出す(§9 落ちない設計)。

import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { LIVE } from "../config/scoring";
import type { LiveState } from "../engine/sessionStore";
import { MeshOverlay, type MeshHandle } from "./MeshOverlay";

type StageProps = {
  stream: MediaStream | null;
  meshRef?: React.Ref<MeshHandle>;
  live: LiveState;
  /** サンプル再生時は映像なしのプレースホルダを出す */
  sampleMode?: boolean;
  overlay?: ReactNode;
};

export const Stage = forwardRef<HTMLVideoElement, StageProps>(function Stage(
  { stream, meshRef, live, sampleMode, overlay },
  videoRef,
) {
  const innerVideoRef = useRef<HTMLVideoElement | null>(null);
  const [faceLost, setFaceLost] = useState(false);

  useEffect(() => {
    const video = innerVideoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      // 自動再生がブロックされた場合もUIは継続する(ユーザー操作後に再生される)
    });
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // 警告表示は 6Hz で十分(§9-2)
  useEffect(() => {
    if (sampleMode) return;
    const id = setInterval(() => {
      setFaceLost(!live.faceDetected);
    }, 1000 / LIVE.METER_TEXT_HZ);
    return () => clearInterval(id);
  }, [live, sampleMode]);

  return (
    <div className="stage">
      {sampleMode ? (
        <div className="sample-placeholder">
          <div className="num">SAMPLE PLAYBACK</div>
          <div>サンプル再生中 — 記録済みシグナルを表示しています</div>
        </div>
      ) : (
        <div className="stage-inner mirror">
          <video
            ref={(el) => {
              innerVideoRef.current = el;
              if (typeof videoRef === "function") videoRef(el);
              else if (videoRef) videoRef.current = el;
            }}
            muted
            playsInline
            autoPlay
          />
          <MeshOverlay ref={meshRef} />
        </div>
      )}
      {!sampleMode && faceLost && <div className="stage-flag">顔を検出できません</div>}
      {overlay}
    </div>
  );
});
