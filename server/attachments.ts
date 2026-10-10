// 応募書類などの添付ファイルの保存場所と形式の判定。面接ごとのフォルダ(attachments/)に置く。

import { rm } from "node:fs/promises";
import path from "node:path";
import type { AttachmentMeta, AttachmentMime, Interview } from "../src/shared/types";
import type { AppContext } from "./context";

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 20;

const KINDS: { mime: AttachmentMime; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: ".pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: ".png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: ".webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** 先頭のバイトから形式を判定する。対応していない形式なら null */
export function sniffAttachment(buf: Buffer): AttachmentMime | null {
  return KINDS.find((k) => k.test(buf))?.mime ?? null;
}

export function attachmentsDir(app: AppContext, iid: string): string {
  return path.join(app.store.interviewDir(iid), "attachments");
}

export function attachmentFile(app: AppContext, iid: string, a: Pick<AttachmentMeta, "id" | "mime">): string {
  const ext = KINDS.find((k) => k.mime === a.mime)?.ext ?? ".bin";
  return path.join(attachmentsDir(app, iid), `${a.id}${ext}`);
}

/** 添付ファイルをすべて消す(面接の削除) */
export async function deleteAttachments(app: AppContext, iv: Interview): Promise<number> {
  const n = iv.attachments.length;
  await rm(attachmentsDir(app, iv.id), { recursive: true, force: true });
  iv.attachments = [];
  return n;
}

/** 条件に合う添付ファイルだけを消す(保存期間)。消した数を返す */
export async function deleteAttachmentsWhere(app: AppContext, iv: Interview, expired: (a: AttachmentMeta) => boolean): Promise<number> {
  const gone = iv.attachments.filter(expired);
  if (gone.length === 0) return 0;
  if (gone.length === iv.attachments.length) return deleteAttachments(app, iv);
  for (const a of gone) await rm(attachmentFile(app, iv.id, a), { force: true });
  iv.attachments = iv.attachments.filter((a) => !gone.includes(a));
  return gone.length;
}

