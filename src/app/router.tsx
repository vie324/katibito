// 最小限のルーター(History API)。録画中など、画面を離れてほしくないときはガードを掛けられる。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

type Guard = () => boolean;

type RouterValue = {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean; force?: boolean }) => void;
  /** ガードを登録する(false を返すと遷移を止める)。解除関数を返す */
  addGuard: (g: Guard) => () => void;
};

const RouterContext = createContext<RouterValue | null>(null);

function current(): { path: string; search: URLSearchParams } {
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(current);
  const guards = useRef(new Set<Guard>());

  useEffect(() => {
    const onPop = () => {
      for (const g of guards.current) {
        if (!g()) {
          // 戻る操作を取り消す
          window.history.pushState(null, "", loc.path + (loc.search.toString() ? `?${loc.search}` : ""));
          return;
        }
      }
      setLoc(current());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loc]);

  const navigate = useCallback((to: string, opts: { replace?: boolean; force?: boolean } = {}) => {
    if (!opts.force) {
      for (const g of guards.current) if (!g()) return;
    }
    if (opts.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLoc(current());
    window.scrollTo(0, 0);
  }, []);

  const addGuard = useCallback((g: Guard) => {
    guards.current.add(g);
    return () => {
      guards.current.delete(g);
    };
  }, []);

  const value = useMemo(
    () => ({ path: loc.path, search: loc.search, navigate, addGuard }),
    [loc, navigate, addGuard],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("RouterProvider がありません");
  return v;
}

/** パターン("/interviews/:id")に一致すればパラメータを返す */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      try {
        params[p[i].slice(1)] = decodeURIComponent(s[i]);
      } catch {
        return null;
      }
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/**
 * 画面を離れようとしたときに確認する(録画中・未送信のデータがあるとき)。
 * ブラウザのタブを閉じる/再読み込みにも効く。
 */
export function useLeaveGuard(active: boolean, message: string): void {
  const { addGuard } = useRouter();
  useEffect(() => {
    if (!active) return;
    const remove = addGuard(() => window.confirm(message));
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      remove();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active, message, addGuard]);
}
