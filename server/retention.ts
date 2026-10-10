// 保存期間による録画の削除。
// - 判定確定から videoDaysAfterDecision 日を過ぎた録画の映像・顔トラックを消す(集計の数値は残す)
// - 判定が出ないまま videoDaysUndecided 日を過ぎた録画も同様
// - 完了しなかったアップロード(7日以上放置)は丸ごと消す
// - 判定確定から attachmentDaysAfterDecision 日を過ぎた応募書類(添付ファイル)を消す

import { deleteAttachments } from "./attachments";
import type { AppContext } from "./context";
import { deleteRecordingFiles } from "./recordings";

const DAY = 24 * 3600_000;
const STALE_UPLOAD_MS = 7 * DAY;

export type RetentionResult = { purged: number; staleRemoved: number; attachmentsPurged: number };

export async function runRetention(ctx: AppContext, now = Date.now()): Promise<RetentionResult> {
  const { store } = ctx;
  const { videoDaysAfterDecision, videoDaysUndecided, attachmentDaysAfterDecision } = store.settings.retention;
  let purged = 0;
  let staleRemoved = 0;
  let attachmentsPurged = 0;

  for (const iid of [...store.interviews.keys()]) {
    await store.withLock(iid, async () => {
      const iv = store.interviews.get(iid);
      if (!iv) return;
      let changed = false;
      for (const rec of iv.recordings) {
        if (rec.status === "uploading") {
          if (now - Date.parse(rec.createdAt) > STALE_UPLOAD_MS) {
            await deleteRecordingFiles(ctx, iv.id, rec, false);
            rec.status = "failed";
            rec.error = "アップロードが完了しないまま保存期間を過ぎたため削除しました";
            rec.analysis = "none";
            rec.purgedAt = new Date(now).toISOString();
            staleRemoved++;
            changed = true;
          }
          continue;
        }
        if (rec.status !== "ready" && rec.status !== "failed") continue;
        // 起点はサーバーが受け付けた時刻。録画開始時刻は端末の時計・動画ファイルの日時なので使わない
        // (時計のずれた端末や古い動画の取り込みで、評価前に消えてしまわないように)
        const limit = iv.decision
          ? Date.parse(iv.decision.decidedAt) + videoDaysAfterDecision * DAY
          : Date.parse(rec.createdAt) + videoDaysUndecided * DAY;
        if (!(now > limit)) continue;
        await deleteRecordingFiles(ctx, iv.id, rec, true);
        rec.status = "purged";
        rec.fileName = null;
        // 文字起こし(話した内容)も映像と一緒に消える(残すのは表情の集計の数値だけ)
        rec.transcript = "none";
        rec.transcriptError = null;
        rec.purgedAt = new Date(now).toISOString();
        purged++;
        changed = true;
      }
      if (iv.decision && iv.attachments.length > 0 && now > Date.parse(iv.decision.decidedAt) + attachmentDaysAfterDecision * DAY) {
        attachmentsPurged += await deleteAttachments(ctx, iv);
        changed = true;
      }
      if (changed) await store.saveInterview(iv);
    });
  }

  if (purged + staleRemoved + attachmentsPurged > 0) {
    await ctx.audit.write({
      userId: null,
      userName: "system",
      action: "retention_purge",
      interviewId: null,
      detail: `purged=${purged} stale=${staleRemoved} attachments=${attachmentsPurged}`,
      ip: null,
    });
  }
  return { purged, staleRemoved, attachmentsPurged };
}
