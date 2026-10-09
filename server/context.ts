// サーバー全体で共有する依存関係。

import type { Audit } from "./audit";
import type { LoginLimiter, Sessions } from "./auth";
import type { Config } from "./config";
import type { Store } from "./store";

/** バックグラウンド処理(録画の結合など)。同じキーは重複実行しない。テストや停止時に完了を待てる。 */
export class Jobs {
  private readonly running = new Map<string, Promise<void>>();

  run(key: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.running.get(key);
    if (existing) return existing;
    const p = fn()
      .catch((e) => console.error(`[jobs] ${key} が失敗`, e))
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  has(key: string): boolean {
    return this.running.has(key);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()]);
    }
  }
}

export type AppContext = {
  config: Config;
  store: Store;
  sessions: Sessions;
  limiter: LoginLimiter;
  audit: Audit;
  jobs: Jobs;
  /** 初期設定コード(ユーザーがいる間は null) */
  setup: { code: string | null };
  /** 最後に見えた外部URL(通知用。APP_URL があればそちら) */
  lastOrigin: string | null;
};
