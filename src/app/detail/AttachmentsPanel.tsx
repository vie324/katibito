// 応募書類(PDF・画像)の添付と一覧。開くと別のタブで表示する。添付した本人か管理者だけが削除できる。

import { useRef, useState } from "react";
import type { AttachmentMeta, InterviewDetail } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatBytes, formatDateTime } from "../format";
import { useSession } from "../session";
import { useConfirm, useToast } from "../ui";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp";

export function AttachmentsPanel({ detail, setDetail }: { detail: InterviewDetail; setDetail: (d: InterviewDetail) => void }) {
  const { user } = useSession();
  const toast = useToast();
  const [confirmNode, confirm] = useConfirm();
  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const iv = detail.interview;

  const update = (attachments: AttachmentMeta[]) => setDetail({ ...detail, interview: { ...detail.interview, attachments } });

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    let latest: AttachmentMeta[] | null = null;
    for (const f of Array.from(files)) {
      if (f.size > MAX_BYTES) {
        toast(`${f.name}: 20MB を超えるファイルは添付できません`, "error");
        continue;
      }
      setUploading(f.name);
      try {
        const r = await api.uploadAttachment(iv.id, f, f.name, label.trim());
        latest = r.attachments;
      } catch (e) {
        toast(`${f.name}: ${errorMessage(e)}`, "error");
      }
    }
    setUploading(null);
    if (input.current) input.current.value = "";
    if (latest) {
      update(latest);
      setLabel("");
      toast("添付しました");
    }
  };

  const remove = async (a: AttachmentMeta) => {
    const ok = await confirm({ title: "添付ファイルを削除", body: `「${a.name}」を削除します。元に戻せません。`, ok: "削除する", danger: true });
    if (!ok) return;
    try {
      update((await api.deleteAttachment(iv.id, a.id)).attachments);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <section className="panel attachments">
      {confirmNode}
      <div className="panel-title">
        応募書類 <span className="muted num">{iv.attachments.length > 0 ? iv.attachments.length : ""}</span>
      </div>
      {iv.attachments.length > 0 && (
        <ul className="attachment-list">
          {iv.attachments.map((a) => {
            const url = api.attachmentUrl(iv.id, a.id);
            return (
              <li key={a.id}>
                <a href={url} target="_blank" rel="noopener" className="attachment-thumb" title="別のタブで開く">
                  {a.mime.startsWith("image/") ? <img src={url} alt="" loading="lazy" /> : <span className="pdf-mark">PDF</span>}
                </a>
                <div className="grow">
                  <a href={url} target="_blank" rel="noopener" className="attachment-name">
                    {a.label && <span className="badge">{a.label}</span>} {a.name}
                  </a>
                  <div className="muted small">
                    {formatBytes(a.sizeBytes)} ・ {a.uploadedByName} ・ {formatDateTime(a.uploadedAt)}
                  </div>
                </div>
                {(a.uploadedBy === user?.id || user?.role === "admin") && (
                  <button className="quiet small danger-text" onClick={() => void remove(a)}>
                    削除
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="pad attachment-add">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
          placeholder="書類の種類(願書・作文など。任意)"
          aria-label="書類の種類"
          list="attachment-labels"
        />
        <datalist id="attachment-labels">
          {["願書", "作文", "成績資料", "推薦書", "本人確認"].map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => void upload(e.target.files)} />
        <button disabled={uploading !== null} onClick={() => input.current?.click()}>
          {uploading ? `送信中… ${uploading}` : "ファイルを添付"}
        </button>
        <div className="muted small">PDF・JPEG・PNG・WebP(1件 20MB まで)。判定から一定の日数で自動的に削除されます。</div>
      </div>
    </section>
  );
}
