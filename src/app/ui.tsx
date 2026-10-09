// 共通の画面部品。

import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { STATUS_LABEL, VOTE_LABEL } from "../shared/status";
import type { InterviewStatus, Vote } from "../shared/types";

/**
 * 入力欄とラベル。ラベルは htmlFor で入力欄に結びつけ、読み上げ名がラベルの文言だけになるようにする
 * (「必須」の印や説明文は aria-describedby で補足として読ませる)。
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const child = isValidElement<{ id?: string; "aria-describedby"?: string; required?: boolean }>(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        "aria-describedby": hintId,
      })
    : children;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && (
          <span className="req" aria-hidden>
            必須
          </span>
        )}
      </label>
      {child}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
}

export function StatusChip({ status }: { status: InterviewStatus }) {
  return <span className={`chip chip-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function VoteChip({ vote, large }: { vote: Vote; large?: boolean }) {
  return <span className={`vote vote-${vote} ${large ? "vote-large" : ""}`}>{VOTE_LABEL[vote]}</span>;
}

export function Loading({ label = "読み込み中" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {label !== undefined && <span className="progress-label num">{label}</span>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="quiet" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 確認ダイアログ(取り消せない操作の前に) */
export function useConfirm(): [ReactNode, (opts: { title: string; body: ReactNode; ok: string; danger?: boolean }) => Promise<boolean>] {
  const [state, setState] = useState<{
    title: string;
    body: ReactNode;
    ok: string;
    danger?: boolean;
    resolve: (v: boolean) => void;
  } | null>(null);
  const ask = useCallback(
    (opts: { title: string; body: ReactNode; ok: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Modal title={state.title} onClose={() => close(false)}>
      <div className="confirm-body">{state.body}</div>
      <div className="row-actions">
        <button className="quiet" onClick={() => close(false)}>
          キャンセル
        </button>
        <button className={state.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
          {state.ok}
        </button>
      </div>
    </Modal>
  ) : null;
  return [node, ask];
}

// ---------------------------------------------------------------- トースト

type Toast = { id: number; text: string; kind: "ok" | "error" | "info" };
const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** 非同期操作の実行中フラグとエラー表示をまとめる */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setError: (e: string | null) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
