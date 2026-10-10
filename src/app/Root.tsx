// 画面の振り分け。/demo は従来の行動シグナル解析デモ(ログイン不要・サーバー不要)。
// /c/<トークン> は本人・保護者が事前の同意を入力するページ(ログイン不要)。
// API サーバーがない静的ホスティングで開かれた場合は、どのパスでもデモを出す。

import { lazy, Suspense, useEffect } from "react";
import { Layout } from "./Layout";
import { InterviewDetailPage } from "./pages/InterviewDetailPage";
import { InterviewEditPage } from "./pages/InterviewEditPage";
import { InterviewListPage } from "./pages/InterviewListPage";
import { LoginPage, SetupPage } from "./pages/AuthPages";
import { AccountPage } from "./pages/AccountPage";
import { matchPath, RouterProvider, useRouter } from "./router";
import { SessionProvider, useSession } from "./session";
import { Loading, Notice, ToastProvider } from "./ui";
import { uploader } from "./record/uploader";

const DemoApp = lazy(() => import("../demo/DemoApp"));
const RecordPage = lazy(() => import("./pages/RecordPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const NoticePage = lazy(() => import("./pages/NoticePage"));
const ComparePage = lazy(() => import("./pages/ComparePage"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const PublicConsentPage = lazy(() => import("./pages/PublicConsentPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));

export function Root() {
  return (
    <RouterProvider>
      <RootInner />
    </RouterProvider>
  );
}

function RootInner() {
  const { path } = useRouter();
  if (path === "/demo" || path.startsWith("/demo/")) {
    return (
      <Suspense fallback={<Loading />}>
        <DemoApp />
      </Suspense>
    );
  }
  // 本人・保護者が開く同意のページ(ログイン不要)
  const consent = matchPath("/c/:token", path);
  if (consent) {
    return (
      <Suspense fallback={<Loading />}>
        <PublicConsentPage token={consent.token} />
      </Suspense>
    );
  }
  return (
    <ToastProvider>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </ToastProvider>
  );
}

function AppRoutes() {
  const { path, navigate } = useRouter();
  const { info, user, loading, error, noServer } = useSession();

  // 送信待ちの録画があれば、どの画面からでも送信を続ける
  useEffect(() => {
    if (user) void uploader.start();
  }, [user]);

  useEffect(() => {
    if (loading || !info) return;
    if (info.needsSetup && path !== "/setup") navigate("/setup", { replace: true, force: true });
    else if (!info.needsSetup && !user && path !== "/login") {
      const next = path === "/" || path === "/setup" ? "" : `?next=${encodeURIComponent(path)}`;
      navigate(`/login${next}`, { replace: true, force: true });
    }
  }, [loading, info, user, path, navigate]);

  if (loading) return <Loading label="起動中" />;
  // API サーバーのない静的ホスティング(Vercel 等)では、運用画面の代わりにデモを出す
  if (noServer) {
    return (
      <Suspense fallback={<Loading />}>
        <DemoApp />
      </Suspense>
    );
  }
  if (error && !info) {
    return (
      <div className="center-page">
        <Notice kind="error">サーバーに接続できません。{error}</Notice>
      </div>
    );
  }
  if (path === "/setup") return <SetupPage />;
  if (path === "/login") return <LoginPage />;
  if (!user) return <Loading />;

  let page: JSX.Element;
  let m: Record<string, string> | null;
  if (path === "/") page = <InterviewListPage />;
  else if (path === "/interviews/new") page = <InterviewEditPage />;
  else if ((m = matchPath("/interviews/:id/edit", path))) page = <InterviewEditPage id={m.id} />;
  else if ((m = matchPath("/interviews/:id/record", path))) page = <RecordPage id={m.id} />;
  else if ((m = matchPath("/interviews/:id/import", path))) page = <ImportPage id={m.id} />;
  else if ((m = matchPath("/interviews/:id/report", path))) page = <ReportPage id={m.id} />;
  else if ((m = matchPath("/interviews/:id/notice", path)) && user.role === "admin") page = <NoticePage id={m.id} />;
  else if ((m = matchPath("/interviews/:id", path))) page = <InterviewDetailPage id={m.id} />;
  else if (path === "/calendar") page = <CalendarPage />;
  else if (path === "/search") page = <SearchPage />;
  else if (path === "/compare") page = <ComparePage />;
  else if (path === "/settings" && user.role === "admin") page = <SettingsPage />;
  else if (path === "/account") page = <AccountPage />;
  else page = <Notice kind="warn">ページが見つかりません。</Notice>;

  return (
    <Layout>
      <Suspense fallback={<Loading />}>{page}</Suspense>
    </Layout>
  );
}
