// ディスクの使用状況(管理者の画面用)。録画・応募書類・文字起こしのモデルなどの大きさと、空き容量。
// 空きが少なくなると録画の受信・仕上げに失敗するため、早めに気づけるようにする。

import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { StorageUsage } from "../src/shared/types";
import type { AppContext } from "./context";

/** ディレクトリの中のファイルの大きさの合計 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export async function storageUsage(ctx: AppContext): Promise<StorageUsage> {
  const root = ctx.config.dataDir;
  let recordings = 0;
  let attachments = 0;
  let records = 0;
  for (const iv of ctx.store.interviews.values()) {
    const dir = ctx.store.interviewDir(iv.id);
    recordings += await dirSize(path.join(dir, "recordings"));
    attachments += await dirSize(path.join(dir, "attachments"));
    for (const f of ["interview.json", "notes.json"]) records += (await stat(path.join(dir, f)).catch(() => null))?.size ?? 0;
    records += await dirSize(path.join(dir, "evaluations"));
  }
  const models = await dirSize(ctx.config.transcription.modelsDir ?? path.join(root, "models"));
  const audit = await dirSize(path.join(root, "audit"));
  let free: number | null = null;
  let total: number | null = null;
  try {
    const st = await statfs(root);
    free = st.bavail * st.bsize;
    total = st.blocks * st.bsize;
  } catch {
    // 空き容量を調べられない環境
  }
  return { recordings, attachments, records, models, audit, free, total };
}
