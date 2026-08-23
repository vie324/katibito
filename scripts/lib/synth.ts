// 合成セッション生成。
// 用途: (1) sample-session.json の生成(§9 サンプル再生モード)
//       (2) 受入基準の識別力・再現性テスト(§13)
// 実際の特徴量抽出・スコアリングと同じコードパスを通す。

import { BLEND_COUNT, BS } from "../../src/engine/blendshapeNames";
import type { QuestionFrames } from "../../src/engine/ringBuffer";

/** 決定論的 PRNG(mulberry32)。再現性テストのため Math.random は使わない。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SynthProfile = {
  name: string;
  /** 音響 */
  rmsBase: number;
  rmsJitter: number;
  f0Base: number;
  f0CVTarget: number;
  latencyMs: number;
  utteranceSec: [number, number];
  pauseSec: [number, number];
  /** 表情 */
  smileEverySec: number;
  smileAmp: number;
  smileDurSec: number;
  browEverySec: number;
  browAmp: number;
  nodAmpDeg: number;
  nodHz: number;
  nodEverySec: number;
  blinkEverySec: number;
  /** 言語 */
  charPerMinTarget: number;
  sentencePool: string[];
};

export const PROFILES: Record<"energetic" | "subdued" | "balanced", SynthProfile> = {
  /** 意図的に大きな声・笑顔多め(§13 受入基準の高side) */
  energetic: {
    name: "energetic",
    rmsBase: 0.095,
    rmsJitter: 0.02,
    f0Base: 155,
    f0CVTarget: 0.26,
    latencyMs: 450,
    utteranceSec: [4, 8],
    pauseSec: [0.3, 0.6],
    smileEverySec: 6,
    smileAmp: 0.62,
    smileDurSec: 1.8,
    browEverySec: 5,
    browAmp: 0.45,
    nodAmpDeg: 3.5,
    nodHz: 1.6,
    nodEverySec: 5,
    blinkEverySec: 4,
    charPerMinTarget: 390,
    sentencePool: [
      "私は検証環境の刷新を自分で決めました",
      "結果は必ず数字で確認しています",
      "本当に手応えを感じた場面でした",
      "私はまず論点を絞ることが重要ですと伝えました",
      "すごく面白い課題だったので初速を徹底しました",
      "僕は翌週までに移行をやりました",
      "間違いなく効果があったと考えています",
      "私は優先順位を先に決めました",
      "めちゃくちゃ嬉しい結果でした",
      "確実に再現できる手順にしています",
    ],
  },
  /** 意図的に無表情・小声(§13 受入基準の低side) */
  subdued: {
    name: "subdued",
    rmsBase: 0.026,
    rmsJitter: 0.006,
    f0Base: 108,
    f0CVTarget: 0.09,
    latencyMs: 2100,
    utteranceSec: [2, 4],
    pauseSec: [0.9, 1.5],
    smileEverySec: 28,
    smileAmp: 0.2,
    smileDurSec: 1.0,
    browEverySec: 24,
    browAmp: 0.22,
    nodAmpDeg: 0.4,
    nodHz: 1.0,
    nodEverySec: 30,
    blinkEverySec: 3,
    charPerMinTarget: 255,
    sentencePool: [
      "たぶんうまくいったような気がします",
      "ちょっと難しい部分もあったかもしれません",
      "一応そのように進めた感じです",
      "なんか、まあ、そういう流れだったと思います",
      "おそらく問題はなかったのではないかと",
      "みたいな形だったと思うんですけど",
      "的なところはあった気がします",
      "そういうことだったのかなと思います",
    ],
  },
  /** sample-session.json 用のプロファイル(やや高め・発信型に落ちる想定) */
  balanced: {
    name: "balanced",
    rmsBase: 0.068,
    rmsJitter: 0.012,
    f0Base: 132,
    f0CVTarget: 0.21,
    latencyMs: 900,
    utteranceSec: [3, 6],
    pauseSec: [0.4, 0.8],
    smileEverySec: 8,
    smileAmp: 0.5,
    smileDurSec: 1.6,
    browEverySec: 7,
    browAmp: 0.38,
    nodAmpDeg: 2.6,
    nodHz: 1.4,
    nodEverySec: 8,
    blinkEverySec: 3.5,
    charPerMinTarget: 345,
    sentencePool: [
      "私は手順を見直すことにしました",
      "たぶん一番効いたのは共有の頻度だったと思います",
      "結果としては目標を達成しています",
      "すごく学びが多い期間でした",
      "ちょっと時間はかかったかもしれません",
      "自分から相談の場を設定しました",
      "面白い発見もあったと考えています",
      "まあ、途中で迷った場面もありました",
      "最終的には私がまとめ役をやりました",
    ],
  },
};

const FPS = 30;
const DT = 1000 / FPS;

export type SynthQuestion = {
  frames: QuestionFrames;
  segments: { text: string; tMs: number }[];
  shownAtMs: number;
  endAtMs: number;
};

/** 1設問ぶん(durationMs)のフレーム列と確定セグメントを合成する。 */
export function synthesizeQuestion(
  profile: SynthProfile,
  shownAtMs: number,
  durationMs: number,
  rng: () => number,
): SynthQuestion {
  const n = Math.floor(durationMs / DT);
  const frames: QuestionFrames = {
    count: n,
    t: new Float32Array(n),
    detected: new Uint8Array(n),
    blend: new Float32Array(n * BLEND_COUNT),
    yaw: new Float32Array(n),
    pitch: new Float32Array(n),
    roll: new Float32Array(n),
    rms: new Float32Array(n),
    f0: new Float32Array(n),
    voiced: new Uint8Array(n),
  };

  const range = (r: [number, number]) => r[0] + rng() * (r[1] - r[0]);

  // 発話/休止のタイムライン(ms、設問開始からの相対)
  const voicedAt = new Uint8Array(n);
  {
    let cursor = profile.latencyMs;
    let speaking = true;
    while (cursor < durationMs) {
      const len = (speaking ? range(profile.utteranceSec) : range(profile.pauseSec)) * 1000;
      if (speaking) {
        const from = Math.max(0, Math.floor(cursor / DT));
        const to = Math.min(n, Math.floor((cursor + len) / DT));
        voicedAt.fill(1, from, to);
      }
      cursor += len;
      speaking = !speaking;
    }
  }

  // 表情イベントのスケジュール
  const schedule = (everySec: number): number[] => {
    const out: number[] = [];
    let t = (0.3 + rng() * 0.7) * everySec * 1000;
    while (t < durationMs) {
      out.push(t);
      t += everySec * 1000 * (0.7 + rng() * 0.6);
    }
    return out;
  };
  const smileEvents = schedule(profile.smileEverySec);
  const browEvents = schedule(profile.browEverySec);
  const nodEvents = schedule(profile.nodEverySec);
  const blinkEvents = schedule(profile.blinkEverySec);

  const envelope = (tMs: number, events: number[], durMs: number): number => {
    let v = 0;
    for (const ev of events) {
      const d = tMs - ev;
      if (d >= 0 && d < durMs) {
        v = Math.max(v, Math.sin((d / durMs) * Math.PI));
      }
    }
    return v;
  };

  const f0Amp = profile.f0CVTarget / 0.707; // sin の std は振幅の 1/√2
  const yawDriftPhase = rng() * Math.PI * 2;

  for (let i = 0; i < n; i++) {
    const rel = i * DT;
    const t = shownAtMs + rel;
    frames.t[i] = t;
    frames.detected[i] = rng() < 0.985 ? 1 : 0;

    const voiced = voicedAt[i] === 1;
    frames.voiced[i] = voiced ? 1 : 0;
    frames.rms[i] = voiced
      ? Math.max(0.005, profile.rmsBase + (rng() - 0.5) * 2 * profile.rmsJitter)
      : 0.0015 + rng() * 0.001;
    frames.f0[i] = voiced
      ? profile.f0Base *
        (1 + f0Amp * Math.sin((rel / 1000) * 2 * Math.PI * 0.25) + (rng() - 0.5) * 0.03)
      : NaN;

    const base = i * BLEND_COUNT;
    const smileEnv = envelope(rel, smileEvents, profile.smileDurSec * 1000);
    const smile = 0.03 + smileEnv * profile.smileAmp * (0.85 + rng() * 0.3);
    frames.blend[base + BS.smileL] = smile * (0.95 + rng() * 0.1);
    frames.blend[base + BS.smileR] = smile * (0.95 + rng() * 0.1);
    frames.blend[base + BS.cheekL] = smileEnv > 0.3 ? smile * 0.55 : 0.01;
    frames.blend[base + BS.cheekR] = smileEnv > 0.3 ? smile * 0.55 : 0.01;

    const browEnv = envelope(rel, browEvents, 700);
    const brow = 0.02 + browEnv * profile.browAmp;
    frames.blend[base + BS.browInner] = brow;
    frames.blend[base + BS.browOuterL] = brow * 0.8;
    frames.blend[base + BS.browOuterR] = brow * 0.8;

    const blinkEnv = envelope(rel, blinkEvents, 130);
    const blink = blinkEnv > 0.4 ? 0.85 : 0.05;
    frames.blend[base + BS.blinkL] = blink;
    frames.blend[base + BS.blinkR] = blink;

    // 頭部姿勢: うなずきイベント + ゆっくりしたドリフト
    const nodEnv = envelope(rel, nodEvents, 1600);
    frames.pitch[i] =
      nodEnv * profile.nodAmpDeg * Math.sin((rel / 1000) * 2 * Math.PI * profile.nodHz) +
      1.5 * Math.sin((rel / 1000) * 0.13 + yawDriftPhase) +
      (rng() - 0.5) * 0.15;
    frames.yaw[i] = 2.2 * Math.sin((rel / 1000) * 0.09 + yawDriftPhase) + (rng() - 0.5) * 0.2;
    frames.roll[i] = 1.2 * Math.sin((rel / 1000) * 0.07) + (rng() - 0.5) * 0.15;
  }

  // 確定セグメント: 発話時間に応じた文字数になるよう文プールから組み立てる
  const voicedFrames = voicedAt.reduce((a, b) => a + b, 0);
  const speechSec = voicedFrames / FPS;
  const targetChars = (profile.charPerMinTarget * speechSec) / 60;
  const segments: { text: string; tMs: number }[] = [];
  {
    let chars = 0;
    let poolIdx = Math.floor(rng() * profile.sentencePool.length);
    let segCount = 0;
    const estSegments = Math.max(3, Math.round(targetChars / 55));
    while (chars < targetChars) {
      const sentences: string[] = [];
      const perSeg = 1 + Math.floor(rng() * 2);
      for (let s = 0; s < perSeg && chars < targetChars; s++) {
        const sentence = profile.sentencePool[poolIdx % profile.sentencePool.length];
        poolIdx++;
        sentences.push(sentence);
        chars += sentence.length;
      }
      segCount++;
      const tMs = Math.min(
        shownAtMs + durationMs - 500,
        shownAtMs +
          profile.latencyMs +
          (durationMs - profile.latencyMs) * (segCount / (estSegments + 1)),
      );
      segments.push({ text: sentences.join("。") + "。", tMs: Math.round(tMs) });
    }
  }

  return { frames, segments, shownAtMs, endAtMs: shownAtMs + durationMs };
}
