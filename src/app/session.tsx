// ログイン状態と設定の共有。

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionInfo, Settings, UserPublic } from "../shared/types";
import { api, onUnauthorized } from "./api";
import { uploader } from "./record/uploader";

type SessionValue = {
  info: SessionInfo | null;
  user: UserPublic | null;
  loading: boolean;
  error: string | null;
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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [users, setUsers] = useState<UserPublic[]>([]);
  const infoRef = useRef(info);
  infoRef.current = info;

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setInfo(s);
      setError(null);
      return s;
    } catch (e) {
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

  // ログインしたら設定とユーザー一覧を読む
  const userId = info?.user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setSettings(null);
      setUsers([]);
      return;
    }
    void reloadSettings();
    void reloadUsers();
  }, [userId, reloadSettings, reloadUsers]);

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

  const setUser = useCallback((u: UserPublic | null) => {
    setInfo((prev) => (prev ? { ...prev, user: u, needsSetup: false } : prev));
  }, []);

  return (
    <SessionContext.Provider
      value={{
        info,
        user: info?.user ?? null,
        loading,
        error,
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
