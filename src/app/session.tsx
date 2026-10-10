// ログイン状態と設定の共有。

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionInfo, Settings, UserPublic } from "../shared/types";
import { api, ApiError, onUnauthorized } from "./api";
import { uploader } from "./record/uploader";

type SessionValue = {
  info: SessionInfo | null;
  user: UserPublic | null;
  loading: boolean;
  error: string | null;
  /** API サーバーがない(静的ホスティングでの公開)。運用画面は使えないのでデモを出す */
  noServer: boolean;
  refresh: () => Promise<SessionInfo | null>;
  setUser: (u: UserPublic | null) => void;
  settings: Settings | null;
  reloadSettings: () => Promise<Settings | null>;
  users: UserPublic[];
  reloadUsers: () => Promise<UserPublic[]>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noServer, setNoServer] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [users, setUsers] = useState<UserPublic[]>([]);
  const infoRef = useRef(info);
  infoRef.current = info;

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      // 静的ホスティングが index.html などを返した場合(JSON のセッション情報ではない)
      if (!s || typeof s !== "object" || typeof (s as Partial<SessionInfo>).needsSetup !== "boolean") {
        setNoServer(true);
        return null;
      }
      setInfo(s);
      setError(null);
      return s;
    } catch (e) {
      // /api/session はこのアプリのサーバーなら必ずある。404 は API サーバーがない(静的ホスティング)
      if (e instanceof ApiError && e.status === 404) setNoServer(true);
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadSettings = useCallback(async () => {
    try {
      const { settings: s } = await api.settings();
      setSettings(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const reloadUsers = useCallback(async () => {
    try {
      const { users: u } = await api.users();
      setUsers(u);
      return u;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ログインしたら設定とユーザー一覧を読む。2段階認証の設定を求められている間は読めない(403)ので、
  // 設定が済んで mustSetupTotp が外れたときに読み直す
  const userId = info?.user?.id ?? null;
  const mustSetupTotp = info?.mustSetupTotp ?? false;
  useEffect(() => {
    if (!userId || mustSetupTotp) {
      setSettings(null);
      setUsers([]);
      return;
    }
    void reloadSettings();
    void reloadUsers();
  }, [userId, mustSetupTotp, reloadSettings, reloadUsers]);

  // セッション切れ。録画中はログイン画面に移動させない(録画を止めないため)。
  // 送信は「ログイン待ち」で止まり、録画を終えてからログインし直せば続きを送る
  useEffect(
    () =>
      onUnauthorized(() => {
        if (uploader.activeRecording) return;
        if (infoRef.current?.user) setInfo((prev) => (prev ? { ...prev, user: null } : prev));
      }),
    [],
  );

  const setUser = useCallback(
    (u: UserPublic | null) => {
      setInfo((prev) => (prev ? { ...prev, user: u, needsSetup: false } : prev));
      // 使える機能・2段階認証の要否はログインした人で変わるので、読み直す
      if (u) void refresh();
    },
    [refresh],
  );

  return (
    <SessionContext.Provider
      value={{
        info,
        user: info?.user ?? null,
        loading,
        error,
        noServer,
        refresh,
        setUser,
        settings,
        reloadSettings,
        users,
        reloadUsers,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("SessionProvider がありません");
  return v;
}
