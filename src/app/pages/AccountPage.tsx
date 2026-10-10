// 自分のアカウント(メールのお知らせ・パスワード変更)。

import { useEffect, useState, type FormEvent } from "react";
import type { NotifyPrefs } from "../../shared/types";
import { api, errorMessage } from "../api";
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
