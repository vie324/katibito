// Web Speech API ラッパ(§5.5)。
// 注意(§3): Chrome の音声認識は音声を Google のサーバーに送信する。
// このことは環境チェック画面に明示する。オフでも全体が動くこと。

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechHandlers = {
  /** isFinal になった文を受け取る。tMs はセッションクロック */
  onFinal: (text: string, tMs: number) => void;
  onInterim: (text: string) => void;
  /** 認識が使えなくなった(権限・ネットワーク等)。言語特徴を無効化する */
  onUnavailable: (reason: string) => void;
};

export class SpeechEngine {
  static supported(): boolean {
    return getCtor() !== null;
  }

  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  private unavailable = false;

  constructor(
    private readonly handlers: SpeechHandlers,
    private readonly now: () => number,
  ) {}

  start(): void {
    if (this.active || this.unavailable) return;
    const Ctor = getCtor();
    if (!Ctor) {
      this.markUnavailable("この環境では音声認識を使えません");
      return;
    }
    this.active = true;
    this.spawn(Ctor);
  }

  private spawn(Ctor: SpeechRecognitionCtor): void {
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) {
          this.handlers.onFinal(text, this.now());
        } else {
          interim += text;
        }
      }
      this.handlers.onInterim(interim);
    };

    rec.onerror = (e) => {
      // no-speech / aborted は継続、権限・ネットワーク系は打ち切り
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.markUnavailable("音声認識の権限がありません");
      } else if (e.error === "network") {
        this.markUnavailable("音声認識サービスに接続できません");
      }
    };

    // Chrome は定期的に勝手に止まるので、稼働中なら再起動する
    rec.onend = () => {
      if (this.active && !this.unavailable) {
        try {
          rec.start();
        } catch {
          setTimeout(() => {
            if (this.active && !this.unavailable) {
              try {
                rec.start();
              } catch {
                this.markUnavailable("音声認識を再開できません");
              }
            }
          }, 250);
        }
      }
    };

    try {
      rec.start();
    } catch {
      this.markUnavailable("音声認識を開始できません");
    }
  }

  private markUnavailable(reason: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.active = false;
    this.handlers.onUnavailable(reason);
  }

  get isUnavailable(): boolean {
    return this.unavailable;
  }

  stop(): void {
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      // 停止時のエラーは無視してよい
    }
    this.rec = null;
  }
}
