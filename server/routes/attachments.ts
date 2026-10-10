// 応募書類などの添付ファイル(PDF・画像)の API。ファイルの形式は名前や Content-Type ではなく先頭のバイトで確かめる。

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentMeta } from "../../src/shared/types";
import { id, str } from "../../src/shared/validate";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, attachmentFile, sniffAttachment } from "../attachments";
import type { AppContext } from "../context";
import { HANDLED, HttpError, readBinary, type Router } from "../http";
import { sendFileRange } from "../media";
import { newId } from "../store";
import { audit, auditView, getInterview } from "./interviews";

/** 画面に出すファイル名: 制御文字とパスの区切りを除き、長すぎるものは切る */
function cleanName(raw: string): string {
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  return base.trim().slice(0, 120) || "file";
}

function inlineHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerAttachmentRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  // 本文はファイルそのもの(application/octet-stream)。名前と種類はクエリで受け取る
  r.post("/api/interviews/:id/attachments", "user", async (c) => {
    getInterview(app, c.params.id);
    const name = cleanName(str(c.query.get("name") ?? "", "ファイル名", { max: 300, min: 1 }));
    const label = str(c.query.get("label") ?? "", "書類の種類", { max: 40, optional: true });
    const buf = await readBinary(c, ATTACHMENT_MAX_BYTES);
    if (buf.length === 0) throw new HttpError(400, "ファイルが空です");
    const mime = sniffAttachment(buf);
    if (!mime) throw new HttpError(415, "添付できるのは PDF・JPEG・PNG・WebP のファイルです");

    const attachment = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (iv.attachments.length >= ATTACHMENT_MAX_FILES) {
        throw new HttpError(409, `添付できるファイルは1つの面接につき ${ATTACHMENT_MAX_FILES} 件までです`);
      }
      const a: AttachmentMeta = {
        id: newId(),
        name,
        label,
        mime,
        sizeBytes: buf.length,
        uploadedBy: c.user!.id,
        uploadedByName: c.user!.name,
        uploadedAt: new Date().toISOString(),
      };
      const file = attachmentFile(app, iv.id, a);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.part`, buf);
      await rename(`${file}.part`, file);
      iv.attachments.push(a);
      try {
        await store.saveInterview(iv);
      } catch (e) {
        iv.attachments.pop();
        await rm(file, { force: true });
        throw e;
      }
      return a;
    });
    await audit(app, c, "attachment_upload", c.params.id, `${attachment.label ? `${attachment.label}: ` : ""}${attachment.name}`);
    return { attachment, attachments: getInterview(app, c.params.id).attachments };
  });

  // 見る(既定は画面に表示、?download=1 で保存)
  r.get("/api/interviews/:id/attachments/:aid", "user", async (c) => {
    const iv = getInterview(app, c.params.id);
    const aid = id(c.params.aid, "添付ファイル");
    const a = iv.attachments.find((x) => x.id === aid);
    if (!a) throw new HttpError(404, "添付ファイルが見つかりません");
    await auditView(app, c, "attachment_view", iv.id, a.id);
    c.res.setHeader(
      "Content-Disposition",
      c.query.get("download") === "1" ? inlineHeader(a.name).replace(/^inline/, "attachment") : inlineHeader(a.name),
    );
    try {
      await sendFileRange(c.req, c.res, attachmentFile(app, iv.id, a), a.mime, "private, no-cache");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || c.res.headersSent) throw e;
      c.res.removeHeader("Content-Disposition");
      throw new HttpError(404, "添付ファイルが見つかりません");
    }
    return HANDLED;
  });

  // 消す(添付した本人か管理者)
  r.delete("/api/interviews/:id/attachments/:aid", "user", async (c) => {
    const aid = id(c.params.aid, "添付ファイル");
    const removed = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const a = iv.attachments.find((x) => x.id === aid);
      if (!a) throw new HttpError(404, "添付ファイルが見つかりません");
      if (a.uploadedBy !== c.user!.id && c.user!.role !== "admin") throw new HttpError(403, "添付した人か管理者だけが削除できます");
      iv.attachments = iv.attachments.filter((x) => x.id !== aid);
      await store.saveInterview(iv);
      await rm(attachmentFile(app, iv.id, a), { force: true });
      return a;
    });
    await audit(app, c, "attachment_delete", c.params.id, removed.name);
    return { attachments: getInterview(app, c.params.id).attachments };
  });
}
