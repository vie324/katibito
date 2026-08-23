import type { ScoreResult } from "../engine/scoring";
import type { ReplayFile, Session } from "../engine/sessionStore";

/** 結果画面に渡す一式 */
export type ResultData = {
  session: Session;
  score: ScoreResult;
  replay: ReplayFile;
  /** ライブ収録時のみ。エクスポートには含めない(§8) */
  videoUrl: string | null;
  mode: "live" | "sample";
};
