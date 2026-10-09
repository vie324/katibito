// 候補者の顔の追跡。対面面接では面接官の顔がフレームに入ることがあるため、
// 「最初に選んだ顔の近くにいる顔」だけを候補者として扱う。
// - 選択前: いちばん大きく映っている顔を自動で選ぶ
// - 追跡中: 前回位置から顔の大きさ相応の範囲内にある最も近い顔
// - 見失った: 一定時間後、最後の位置の近くで再捕捉する(遠くの別人には乗り換えない)
// 座標はすべて正規化(0〜1)。DOM に依存しない。

export type Box = { x0: number; y0: number; x1: number; y1: number };

export type CandidateOptions = {
  /** 映像の縦横比(幅/高さ)。距離を高さ基準にそろえるため */
  aspect: number;
  /** 1フレームで許容する移動量(顔の高さに対する倍率) */
  maxJumpFaces: number;
  /** 見失ってからこの時間が経てば、再捕捉の範囲を広げる */
  reacquireAfterMs: number;
  /** 再捕捉の探索半径(映像の高さに対する割合) */
  reacquireRadius: number;
  /** 位置の追従の速さ(EMA 係数) */
  follow: number;
};

const DEFAULTS: CandidateOptions = {
  aspect: 16 / 9,
  maxJumpFaces: 1.2,
  reacquireAfterMs: 1500,
  reacquireRadius: 0.3,
  follow: 0.35,
};

export type TargetState = { cx: number; cy: number; h: number };

export function boxCenter(b: Box): { cx: number; cy: number; h: number } {
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, h: Math.max(0, b.y1 - b.y0) };
}

/** 指定点を含む顔(なければ最も近い顔)の位置。顔がなければ -1。 */
export function pickBoxAt(boxes: Box[], x: number, y: number, aspect = DEFAULTS.aspect): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return i;
    const c = boxCenter(b);
    const d = Math.hypot((c.cx - x) * aspect, c.cy - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export class CandidateTracker {
  private readonly opts: CandidateOptions;
  private target: TargetState | null = null;
  private lostSince: number | null = null;

  constructor(opts: Partial<CandidateOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get current(): TargetState | null {
    return this.target ? { ...this.target } : null;
  }

  get isLost(): boolean {
    return this.lostSince !== null;
  }

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.opts.aspect = aspect;
  }

  /** 利用者が選んだ顔を追跡対象にする */
  setTarget(cx: number, cy: number, h = 0.15): void {
    this.target = { cx, cy, h: Math.max(0.02, h) };
    this.lostSince = null;
  }

  reset(): void {
    this.target = null;
    this.lostSince = null;
  }

  /** このフレームの候補者の顔の位置。取れなければ -1。 */
  pick(boxes: Box[], tMs: number): number {
    if (boxes.length === 0) {
      this.markLost(tMs);
      return -1;
    }

    if (this.target === null) {
      let largest = 0;
      for (let i = 1; i < boxes.length; i++) {
        if (boxCenter(boxes[i]).h > boxCenter(boxes[largest]).h) largest = i;
      }
      const c = boxCenter(boxes[largest]);
      this.target = { ...c };
      this.lostSince = null;
      return largest;
    }

    const tgt = this.target;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const c = boxCenter(boxes[i]);
      const d = Math.hypot((c.cx - tgt.cx) * this.opts.aspect, c.cy - tgt.cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }

    const c = boxCenter(boxes[best]);
    const allowed = this.opts.maxJumpFaces * Math.max(tgt.h, c.h);
    const canReacquire =
      this.lostSince !== null &&
      tMs - this.lostSince >= this.opts.reacquireAfterMs &&
      bestD <= this.opts.reacquireRadius;

    if (bestD <= allowed || canReacquire) {
      const a = this.opts.follow;
      tgt.cx += (c.cx - tgt.cx) * a;
      tgt.cy += (c.cy - tgt.cy) * a;
      tgt.h += (c.h - tgt.h) * a;
      this.lostSince = null;
      return best;
    }
    this.markLost(tMs);
    return -1;
  }

  private markLost(tMs: number): void {
    if (this.lostSince === null) this.lostSince = tMs;
  }
}
