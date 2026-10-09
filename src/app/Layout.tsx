// 画面の枠: 上部バー(ナビゲーション・送信状況・ユーザー)。

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "./api";
import { Link, useRouter } from "./router";
import { uploader, type UploadState } from "./record/uploader";
import { useSession } from "./session";
import { ProgressBar } from "./ui";

export function useUploads(): UploadState[] {
  return useSyncExternalStore(
    (fn) => uploader.subscribe(fn),
    uploader.snapshot,
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, info, setUser } = useSession();
  const { path, navigate } = useRouter();
  const uploads = useUploads();
  const pending = uploads.filter((u) => u.phase !== "done");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.title = info?.orgName ? `面接記録 — ${info.orgName}` : "面接記録";
  }, [info?.orgName]);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    navigate("/login", { force: true });
  };

  return (
    <div className="ops">
      <header className="ops-bar">
        <Link to="/" className="brand">
          <span className="brand-main">面接記録</span>
          {info?.orgName && <span className="brand-org">{info.orgName}</span>}
        </Link>
        <nav className="ops-nav">
          <Link to="/" className={path === "/" ? "active" : ""}>
            面接一覧
          </Link>
          {user?.role === "admin" && (
            <Link to="/settings" className={path === "/settings" ? "active" : ""}>
              設定
            </Link>
          )}
        </nav>
        <span className="spacer" />
        {pending.length > 0 && (
          <button className="quiet upload-indicator" onClick={() => setOpen((v) => !v)}>
            <span className={`dot ${pending.some((p) => p.phase === "error") ? "bad" : pending.some((p) => p.phase === "offline") ? "warn" : "busy"}`} />
            録画を送信中 {pending.length}件
          </button>
        )}
        <Link to="/account" className="user-link">
          {user?.name}
          {user?.role === "admin" && <span className="role">管理者</span>}
        </Link>
        <button className="quiet" onClick={() => void logout()}>
          ログアウト
        </button>
      </header>
      {open && pending.length > 0 && (
        <div className="upload-panel">
          {pending.map((u) => (
            <UploadRow key={u.localId} u={u} />
          ))}
          <div className="upload-note">
            送信が終わるまで、この端末の電源を切ったりブラウザのデータを消したりしないでください。
            ページを閉じても、次にこの端末でアプリを開くと続きから送信します。
          </div>
        </div>
      )}
      <main className="ops-main">{children}</main>
    </div>
  );
}

const PHASE_LABEL: Record<UploadState["phase"], string> = {
  waiting: "送信待ち",
  uploading: "送信中",
  finishing: "仕上げ中",
  done: "送信済み",
  offline: "接続待ち",
  login: "ログイン待ち",
  error: "送信できません",
};

export function UploadRow({ u }: { u: UploadState }) {
  const frac = u.chunkCount > 0 ? u.uploadedChunks / u.chunkCount : 0;
  return (
    <div className="upload-row">
      <div className="upload-row-head">
        <Link to={`/interviews/${u.interviewId}`}>{u.candidateName}</Link>
        <span className={`upload-phase phase-${u.phase}`}>
          {u.recordingStatus === "recording" ? "録画中・" : ""}
          {PHASE_LABEL[u.phase]}
        </span>
      </div>
      <ProgressBar value={frac} label={`${u.uploadedChunks}/${u.chunkCount}`} />
      {u.error && <div className="upload-error">{u.error}</div>}
      {u.phase === "error" && (
        <div className="row-actions">
          <button className="quiet" onClick={() => void uploader.retry(u.localId)}>
            再試行
          </button>
          <button
            className="quiet danger-text"
            onClick={() => {
              if (window.confirm("この端末に残っている録画を破棄します。サーバーに届いていない部分は失われます。よろしいですか?")) {
                void uploader.discard(u.localId);
              }
            }}
          >
            破棄
          </button>
        </div>
      )}
    </div>
  );
}
