// 自分のアカウント(パスワード変更)。

import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useSession } from "../session";
import { Field, Notice, useAction, useToast } from "../ui";

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
