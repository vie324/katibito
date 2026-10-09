// 面接の詳細: 同意の記録 / 録画と表情の計測 / 評価 / 判定。

import { useEffect, useState } from "react";
import { pickRepresentative, type ExpressionSummary } from "../../analysis/expression";
import type { ExpressionStats, InterviewDetail } from "../../shared/types";
import { api, errorMessage } from "../api";
import { DecisionPanel } from "../detail/DecisionPanel";
import { EvaluationPanel } from "../detail/EvaluationPanel";
import { ReviewPanel } from "../detail/ReviewPanel";
import { formatDateTime } from "../format";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Loading, Modal, Notice, StatusChip, useConfirm, useToast } from "../ui";

export function InterviewDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ExpressionStats | null>(null);
  const [summary, setSummary] = useState<ExpressionSummary | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [confirmNode, confirm] = useConfirm();

  useEffect(() => {
    let alive = true;
    api
      .interview(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(errorMessage(e)));
    api
      .stats()
      .then((s) => alive && setStats(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  // 録画の受信・処理中は状態を追う
  const processing = detail?.interview.recordings.some((r) => r.status === "uploading" || r.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => {
      api
        .interview(id)
        .then(setDetail)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [processing, id]);

  // 判定欄に出す表情の要約(顔が最も長く映っていた録画)
  const analysisKey = detail?.interview.recordings.map((r) => `${r.id}:${r.analysis}:${r.markers.length}`).join("|") ?? "";
  useEffect(() => {
    if (!detail) return;
    const ready = detail.interview.recordings.filter((r) => r.analysis === "ready");
    if (ready.length === 0) {
      setSummary(null);
      return;
    }
    let alive = true;
    Promise.all(ready.map((r) => api.summary(id, r.id).then((x) => x.summary).catch(() => null))).then((list) => {
      if (alive) setSummary(pickRepresentative(list.filter((x): x is ExpressionSummary => !!x)));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey, id]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!detail) return <Loading />;

  const iv = detail.interview;
  const c = iv.consent;
  const decided = !!iv.decision;
  const isAdmin = user?.role === "admin";
  const canRecord = !decided && (!c || c.recording || iv.recordingDeclined);
  const activeRecs = iv.recordings.filter((r) => r.status !== "deleted");

  const deleteInterview = async () => {
    const ok = await confirm({
      title: "この面接を削除しますか?",
      body: "録画・表情の計測・評価・メモ・同意の記録をすべて削除します。元に戻せません。",
      ok: "完全に削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteInterview(iv.id);
      toast("面接を削除しました");
      navigate("/");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const withdraw = async (scope: "analysis" | "all") => {
    try {
      setDetail(await api.withdrawConsent(iv.id, scope));
      setWithdrawOpen(false);
      toast(scope === "all" ? "録画と計測データを削除しました" : "表情の計測データを削除しました");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="page wide">
      {confirmNode}
      <div className="detail-head">
        <Link to="/" className="back">
          ← 面接一覧
        </Link>
        <div className="detail-title">
          <h2>{iv.candidate.displayName}</h2>
          {iv.candidate.kana && <span className="muted">{iv.candidate.kana}</span>}
          <StatusChip status={detail.status} />
        </div>
        <span className="spacer" />
        {canRecord && (
          <>
            <button className="primary" onClick={() => navigate(`/interviews/${iv.id}/record`)}>
              {c?.recording ? "録画を開始" : "同意を取得して録画"}
            </button>
            {(!c || c.recording) && (
              <button onClick={() => navigate(`/interviews/${iv.id}/import`)}>動画を取り込む</button>
            )}
          </>
        )}
        <button className="quiet" onClick={() => navigate(`/interviews/${iv.id}/edit`)}>
          編集
        </button>
        {isAdmin && (
          <button className="quiet danger-text" onClick={() => void deleteInterview()}>
            削除
          </button>
        )}
      </div>

      <div className="detail-info">
        <span>
          <span className="muted">面接日時</span> {formatDateTime(iv.scheduledAt)}
        </span>
        {iv.location && (
          <span>
            <span className="muted">場所</span> {iv.location}
          </span>
        )}
        <span>
          <span className="muted">面接官</span>{" "}
          {detail.interviewers.length > 0 ? detail.interviewers.map((u) => u.name).join("・") : "未設定"}
        </span>
        {iv.candidate.age !== null && (
          <span>
            <span className="muted">年齢</span> {iv.candidate.age}歳
          </span>
        )}
        {iv.candidate.minor && <span className="badge">未成年</span>}
      </div>
      {iv.candidate.note && <div className="detail-note">{iv.candidate.note}</div>}

      <div className="consent-card">
        <span className="muted">同意</span>
        {!c ? (
          <span>未取得</span>
        ) : c.recording ? (
          <span>
            録画 <b>あり</b> ・ 表情の計測 <b>{c.analysis ? "あり" : "なし"}</b>
            <span className="muted small">
              ({c.method === "paper" ? "紙の同意書" : "画面で取得"}・{c.obtainedByName}・{formatDateTime(c.obtainedAt)}
              {c.guardianName ? `・保護者 ${c.guardianName}${c.guardianRelation ? `(${c.guardianRelation})` : ""}` : ""})
            </span>
          </span>
        ) : (
          <span>録画なし(同意を得られなかったため、録画せずに面接)</span>
        )}
        {c?.withdrawnAt && (
          <span className="warn-text small">
            {formatDateTime(c.withdrawnAt)} に{c.withdrawnScope === "all" ? "同意が取り消されました" : "表情の計測への同意が取り消されました"}
          </span>
        )}
        <span className="spacer" />
        {c && (
          <button className="quiet small" onClick={() => setConsentOpen(true)}>
            提示した同意文
          </button>
        )}
        {isAdmin && c && (c.recording || c.analysis) && (
          <button className="quiet small danger-text" onClick={() => setWithdrawOpen(true)}>
            同意の取り消し
          </button>
        )}
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          {activeRecs.length > 0 ? (
            <ReviewPanel detail={detail} setDetail={setDetail} stats={stats} />
          ) : (
            <section className="panel pad empty-review">
              {iv.recordingDeclined ? (
                <p>この面接は録画していません。面接官の評価で判定します。</p>
              ) : (
                <>
                  <p>まだ録画がありません。</p>
                  <p className="muted small">
                    面接の当日に「{c?.recording ? "録画を開始" : "同意を取得して録画"}」から撮影すると、
                    ここで録画と表情の計測結果を確認できるようになります。
                  </p>
                </>
              )}
            </section>
          )}
        </div>
        <div className="detail-side">
          <EvaluationPanel detail={detail} setDetail={setDetail} />
          <DecisionPanel detail={detail} setDetail={setDetail} summary={summary} />
        </div>
      </div>

      {consentOpen && c && (
        <Modal title="提示した同意文" onClose={() => setConsentOpen(false)} wide>
          <div className="consent-doc small-doc">
            {c.consentText.split("\n").map((l, i) => (l.trim() === "" ? <br key={i} /> : <p key={i}>{l}</p>))}
          </div>
          <div className="muted small">版: {c.consentVersion}</div>
        </Modal>
      )}
      {withdrawOpen && (
        <Modal title="同意の取り消し" onClose={() => setWithdrawOpen(false)}>
          <p>候補者(保護者)から取り消しの申し出があった場合に使います。削除したデータは元に戻せません。</p>
          <div className="withdraw-options">
            <button className="danger" onClick={() => void withdraw("analysis")}>
              表情の計測だけ取り消す(計測データを削除)
            </button>
            <button className="danger" onClick={() => void withdraw("all")}>
              録画も含めてすべて取り消す(録画と計測データを削除)
            </button>
          </div>
          <p className="muted small">評価・メモ・判定の記録は残ります。面接ごと消す場合は「削除」を使ってください。</p>
        </Modal>
      )}
    </div>
  );
}
