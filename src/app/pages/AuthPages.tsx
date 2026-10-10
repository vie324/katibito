// 初期設定・ログイン。

import { useState, type FormEvent } from "react";
import type { UserPublic } from "../../shared/types";
import { api } from "../api";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Field, Notice, useAction } from "../ui";

export function SetupPage() {
  const { refresh } = useSession();
  const { navigate } = useRouter();
  const [form, setForm] = useState({ setupCode: "", orgName: "", loginId: "", name: "", password: "", password2: "" });
  const { busy, error, run, setError } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.password2) {
      setError("確認用のパスワードが一致しません");
      return;
    }
    const ok = await run(() =>
      api.setup({
        setupCode: form.setupCode,
        orgName: form.orgName,
        loginId: form.loginId,
        name: form.name,
        password: form.password,
      }),
    );
    if (ok) {
      await refresh();
      navigate("/", { force: true });
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>初期設定</h1>
        <p className="muted">
          最初の管理者アカウントを作ります。初期設定コードは、サーバーを起動したときのログ(画面の出力)に表示されています。
        </p>
        <Field label="初期設定コード" required>
          <input value={form.setupCode} onChange={set("setupCode")} placeholder="XXXX-XXXX" autoComplete="off" required />
        </Field>
        <Field label="団体名" hint="同意文や画面の上部に表示されます">
          <input value={form.orgName} onChange={set("orgName")} />
        </Field>
        <Field label="管理者の氏名" required>
          <input value={form.name} onChange={set("name")} required />
        </Field>
        <Field label="ログインID" required hint="半角英数字">
          <input value={form.loginId} onChange={set("loginId")} autoComplete="username" required />
        </Field>
        <Field label="パスワード" required hint="8文字以上">
          <input type="password" value={form.password} onChange={set("password")} autoComplete="new-password" required />
        </Field>
        <Field label="パスワード(確認)" required>
          <input type="password" value={form.password2} onChange={set("password2")} autoComplete="new-password" required />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="primary wide" disabled={busy}>
          {busy ? "作成中" : "管理者を作成して始める"}
        </button>
      </form>
    </div>
  );
}

export function LoginPage() {
  const { setUser, info } = useSession();
  const { navigate, search } = useRouter();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy, error, run, setError } = useAction();

  const done = (user: UserPublic) => {
    setUser(user);
    const next = search.get("next");
    navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { force: true, replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => api.login(loginId, password));
    if (res?.ticket) {
      setTicket(res.ticket);
      setCode("");
    } else if (res?.user) done(res.user);
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!ticket) return;
    try {
      const res = await run(() => api.loginTotp(ticket, code.trim()));
      if (res) done(res.user);
    } finally {
      setCode("");
    }
  };

  if (ticket) {
    return (
      <div className="center-page">
        <form className="auth-card" onSubmit={submitCode}>
          <h1>面接記録</h1>
          <p className="muted">2段階認証</p>
          <Field label="確認コード" hint="認証アプリに表示されている6桁の数字。スマートフォンが使えないときは、予備のコード(xxxx-xxxx)を入れてください">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={20}
              autoFocus
              required
            />
          </Field>
          {error && <Notice kind="error">{error}</Notice>}
          <button className="primary wide" disabled={busy}>
            {busy ? "確認中" : "確認する"}
          </button>
          <button
            type="button"
            className="quiet wide"
            onClick={() => {
              setTicket(null);
              setPassword("");
              setError(null);
            }}
          >
            ログインIDの入力に戻る
          </button>
          <p className="muted small">スマートフォンをなくした場合は、管理者に2段階認証の解除を依頼してください。</p>
        </form>
      </div>
    );
  }

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>面接記録</h1>
        {info?.orgName && <p className="muted">{info.orgName}</p>}
        <Field label="ログインID">
          <input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="パスワード">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="primary wide" disabled={busy}>
          {busy ? "確認中" : "ログイン"}
        </button>
        <p className="muted small">パスワードを忘れた場合は、管理者に再設定を依頼してください。</p>
      </form>
    </div>
  );
}
