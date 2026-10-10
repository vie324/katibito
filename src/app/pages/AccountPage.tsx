// 自分のアカウント(2段階認証・メールのお知らせ・パスワード変更)。

import { useEffect, useState, type FormEvent } from "react";
import type { NotifyPrefs } from "../../shared/types";
import { api, errorMessage } from "../api";
import { QrCode } from "../components/QrCode";
import { formatDateTime } from "../format";
import { useSession } from "../session";
import { Field, Loading, Notice, useAction, useToast } from "../ui";

export function AccountPage() {
  const { user } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const { busy, error, run, setError } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== next2) {
      setError("確認用のパスワードが一致しません");
      return;
    }
    const ok = await run(() => api.changePassword(current, next));
    if (ok) {
      setCurrent("");
      setNext("");
      setNext2("");
      toast("パスワードを変更しました。ほかの端末ではログインし直しが必要です");
    }
  };

  return (
    <div className="page narrow">
      <h2>アカウント</h2>
      <div className="panel pad">
        <dl className="kv">
          <dt>氏名</dt>
          <dd>{user?.name}</dd>
          <dt>ログインID</dt>
          <dd className="num">{user?.loginId}</dd>
          <dt>権限</dt>
          <dd>{user?.role === "admin" ? "管理者" : "面接官"}</dd>
        </dl>
      </div>
      <TotpSection />
      <NotifyForm />
      <form className="panel pad form" onSubmit={submit}>
        <h3>パスワードの変更</h3>
        <Field label="現在のパスワード">
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="新しいパスワード" hint="8文字以上">
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="新しいパスワード(確認)">
          <input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="row-actions">
          <button className="primary" disabled={busy}>
            変更する
          </button>
        </div>
      </form>
    </div>
  );
}

const PREF_LABEL: { key: keyof NotifyPrefs; label: string; hint: string; adminOnly?: boolean }[] = [
  { key: "evaluation", label: "担当の面接の評価のお願い", hint: "録画が共有されたとき・評価が未提出のときの催促・判定が確定したとき" },
  { key: "dayBefore", label: "担当の面接の前日のお知らせ", hint: "明日担当する面接の日時と場所" },
  { key: "live", label: "面接の録画(ライブ)が始まったとき", hint: "その場にいなくても、数秒遅れで見られます" },
  { key: "admin", label: "判定のお願い・オンラインの同意", hint: "面接官全員の評価がそろったとき・事前の同意が届いたとき", adminOnly: true },
];

function NotifyForm() {
  const { user, info } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [notify, setNotify] = useState<NotifyPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setEmail(r.user.email);
        setNotify(r.user.notify);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!notify) return <Loading />;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveNotify({ email: email.trim(), notify }));
    if (r) {
      setEmail(r.user.email);
      setNotify(r.user.notify);
      toast("お知らせの設定を保存しました");
    }
  };

  return (
    <form className="panel pad form" onSubmit={save}>
      <h3>メールのお知らせ</h3>
      {!info?.features.mail && (
        <Notice kind="info">
          このサーバーでは、まだメールの送信が設定されていません(管理者が設定すると届くようになります)。アドレスは先に登録しておけます。
        </Notice>
      )}
      <Field label="メールアドレス" hint="空にすると、メールは届きません">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" />
      </Field>
      <div className="notify-prefs">
        {PREF_LABEL.filter((p) => !p.adminOnly || user?.role === "admin").map((p) => (
          <label key={p.key} className="check">
            <input type="checkbox" checked={notify[p.key]} onChange={(e) => setNotify({ ...notify, [p.key]: e.target.checked })} />
            <span>
              {p.label}
              <span className="muted small"> — {p.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted small">メールには候補者の表示名・日時・リンクだけが載ります(評価の内容や数値は載りません)。</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="row-actions">
        <button className="primary" disabled={busy}>
          保存する
        </button>
      </div>
    </form>
  );
}

function TotpSection() {
  const { info, user, refresh, settings } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<{ enabled: boolean; enabledAt: string | null; recoveryRemaining: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"none" | "recovery" | "disable">("none");
  const { busy, error, run, setError } = useAction();

  const load = () =>
    api
      .totpStatus()
      .then(setStatus)
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status) return error ? <Notice kind="error">{error}</Notice> : <Loading />;
  const required = user?.role === "admin" && !!info?.mustSetupTotp;
  // 管理者に必須の設定なら、無効にはできない
  const locked = user?.role === "admin" && !!settings?.security.requireTotpForAdmins;

  const start = async () => {
    const r = await run(() => api.totpSetup());
    if (r) {
      setSetup(r);
      setCode("");
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.totpEnable(code.trim()));
    setCode("");
    if (r) {
      setCodes(r.recoveryCodes);
      setSetup(null);
      await load();
      await refresh();
      toast("2段階認証を有効にしました。ほかの端末のログインは解除されました");
    }
  };
  const regenerate = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.totpRecovery(code.trim()));
    setCode("");
    if (r) {
      setCodes(r.recoveryCodes);
      setMode("none");
      await load();
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.totpDisable(password));
    setPassword("");
    if (r) {
      setMode("none");
      await load();
      toast("2段階認証を無効にしました");
    }
  };
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes!.join("\n"));
      toast("予備のコードをコピーしました");
    } catch {
      toast("コピーできませんでした。書き写すか印刷してください", "error");
    }
  };

  return (
    <section className="panel pad form" id="totp">
      <h3>2段階認証</h3>
      {required && <Notice kind="warn">管理者は2段階認証の設定が必要です。設定するまで、ほかの画面は使えません。</Notice>}
      <p className="muted small">
        ログインのときに、パスワードに加えて、スマートフォンの認証アプリ(Google Authenticator・Microsoft Authenticator など)に表示される
        6桁の確認コードを入れるようにします。パスワードが知られても、ほかの人がログインしにくくなります。
      </p>

      {codes && (
        <div className="recovery-codes">
          <div>
            <b>予備のコード</b>
            <span className="muted small"> — スマートフォンが使えないときに、確認コードの代わりに1回ずつ使えます</span>
          </div>
          <ul className="num">
            {codes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="warn-text small">この画面を離れると二度と表示できません。印刷するか、安全な場所に書き写してください。</div>
          <div className="row-actions left">
            <button type="button" onClick={() => void copyCodes()}>
              コピー
            </button>
            <button type="button" className="primary" onClick={() => setCodes(null)}>
              保存しました
            </button>
          </div>
        </div>
      )}

      {!status.enabled && !setup && (
        <div className="row-actions left">
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            設定を始める
          </button>
        </div>
      )}

      {setup && (
        <form className="totp-setup" onSubmit={enable}>
          <QrCode text={setup.uri} size={176} />
          <div className="grow form compact">
            <ol className="small totp-steps">
              <li>認証アプリで「QR コードをスキャン」を選び、左の QR コードを読み取ります</li>
              <li>読み取れないときは、次のキーを手で入力します</li>
            </ol>
            <div className="num totp-secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
            <Field label="アプリに表示された6桁の数字">
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required />
            </Field>
            <div className="row-actions left">
              <button className="primary" disabled={busy}>
                有効にする
              </button>
              <button type="button" className="quiet" onClick={() => setSetup(null)}>
                やめる
              </button>
            </div>
          </div>
        </form>
      )}

      {status.enabled && (
        <>
          <div className="feature-status">
            <span className="ok-text">● 有効</span>
            <span className="muted small">
              {status.enabledAt ? `${formatDateTime(status.enabledAt)} から` : ""} ・ 予備のコード 残り {status.recoveryRemaining} 個
            </span>
          </div>
          {mode === "none" && (
            <div className="row-actions left">
              <button type="button" className="quiet" onClick={() => setMode("recovery")}>
                予備のコードを作り直す
              </button>
              {!locked && (
                <button type="button" className="quiet danger-text" onClick={() => setMode("disable")}>
                  無効にする
                </button>
              )}
            </div>
          )}
          {mode === "recovery" && (
            <form className="form compact" onSubmit={regenerate}>
              <Field label="認証アプリの確認コード" hint="作り直すと、今までの予備のコードは使えなくなります">
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} required />
              </Field>
              <div className="row-actions left">
                <button className="primary" disabled={busy}>
                  作り直す
                </button>
                <button type="button" className="quiet" onClick={() => setMode("none")}>
                  やめる
                </button>
              </div>
            </form>
          )}
          {mode === "disable" && (
            <form className="form compact" onSubmit={disable}>
              <Field label="パスワード" hint="確認のため、ログインのパスワードを入れてください">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
              <div className="row-actions left">
                <button className="danger" disabled={busy}>
                  無効にする
                </button>
                <button type="button" className="quiet" onClick={() => setMode("none")}>
                  やめる
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
