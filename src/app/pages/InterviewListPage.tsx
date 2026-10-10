// 面接一覧。自分の対応待ち(評価・判定)を上に出す。

import { useEffect, useMemo, useState } from "react";
import { formatScore } from "../../shared/score";
import { STATUS_LABEL } from "../../shared/status";
import type { InterviewListItem, InterviewStatus } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatDateTime, formatDuration, formatTime, jstDateKey } from "../format";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { BulkImport } from "../components/BulkImport";
import { Empty, Loading, Notice, StatusChip, useToast, VoteChip } from "../ui";

type Filter = "all" | InterviewStatus;

export function InterviewListPage() {
  const { user, users } = useSession();
  const { navigate } = useRouter();
  const [items, setItems] = useState<InterviewListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .interviews()
        .then((r) => alive && (setItems(r.interviews), setError(null)))
        .catch((e) => alive && setError(errorMessage(e)));
    void load();
    // 送信中の録画があれば状態の変化を追う
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [reload]);

  const names = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);

  const todo = useMemo(() => {
    if (!items || !user) return [];
    return items.filter((it) => {
      if (it.status === "decided") return false;
      const material = it.readyRecordingCount > 0 || it.recordingDeclined;
      const assigned = it.interviewerIds.includes(user.id);
      if (assigned && material && it.myEvaluation !== "submitted") return true;
      if (user.role === "admin" && it.status === "deciding") return true;
      return false;
    });
  }, [items, user]);

  // 今日(日本時間)の面接。当日に録画・ライブ視聴へすぐ進めるように上に出す
  const today = useMemo(() => {
    const key = jstDateKey(new Date());
    return (items ?? [])
      .filter((it) => it.scheduledAt && jstDateKey(it.scheduledAt) === key)
      .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, scheduled: 0, uploading: 0, evaluating: 0, deciding: 0, decided: 0 };
    for (const it of items ?? []) {
      c.all++;
      c[it.status]++;
    }
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (items ?? []).filter(
      (it) =>
        (filter === "all" || it.status === filter) &&
        (!query ||
          it.candidate.displayName.toLowerCase().includes(query) ||
          it.candidate.kana.toLowerCase().includes(query)),
    );
  }, [items, filter, q]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>面接一覧</h2>
        <span className="spacer" />
        {user?.role === "admin" && (
          <button className="quiet" onClick={() => setBulkOpen(true)}>
            まとめて登録
          </button>
        )}
        <button className="primary" onClick={() => navigate("/interviews/new")}>
          面接を登録
        </button>
      </div>
      {bulkOpen && (
        <BulkImport
          onClose={() => setBulkOpen(false)}
          onDone={(n) => {
            setBulkOpen(false);
            toast(`${n}件の面接を登録しました`);
            setReload((x) => x + 1);
          }}
        />
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {!items && !error && <Loading />}

      {today.length > 0 && (
        <div className="panel today-panel">
          <div className="panel-title">今日の面接</div>
          {today.map((it) => (
            <Link key={it.id} to={`/interviews/${it.id}`} className="todo-row">
              <span className="num">{formatTime(it.scheduledAt)}</span>
              <span className="todo-name">{it.candidate.displayName}</span>
              <span className="muted small">{[it.round, it.location].filter(Boolean).join(" ・ ")}</span>
              <span className="spacer" />
              {it.live ? (
                <span className="chip chip-live">● ライブ</span>
              ) : it.decision ? (
                <VoteChip vote={it.decision.result} />
              ) : (
                <StatusChip status={it.status} />
              )}
            </Link>
          ))}
        </div>
      )}

      {todo.length > 0 && (
        <div className="panel todo">
          <div className="panel-title">あなたの対応待ち</div>
          {todo.map((it) => (
            <Link key={it.id} to={`/interviews/${it.id}`} className="todo-row">
              <span className="todo-name">{it.candidate.displayName}</span>
              <span className="muted">{formatDateTime(it.scheduledAt ?? it.createdAt)}</span>
              <span className="spacer" />
              <span className="todo-what">
                {it.status === "deciding" && user?.role === "admin" ? "判定をお願いします" : "評価を入力してください"}
              </span>
            </Link>
          ))}
        </div>
      )}

      {items && (
        <>
          <div className="filter-bar">
            {(["all", "scheduled", "uploading", "evaluating", "deciding", "decided"] as Filter[]).map((f) => (
              <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "すべて" : STATUS_LABEL[f]}
                <span className="num count">{counts[f]}</span>
              </button>
            ))}
            <span className="spacer" />
            <input className="search" placeholder="候補者名で検索" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          {shown.length === 0 ? (
            <Empty>
              {items.length === 0 ? (
                <>
                  まだ面接が登録されていません。<br />
                  「面接を登録」から候補者と面接官を登録すると、当日の録画・評価ができるようになります。
                </>
              ) : (
                "条件に合う面接はありません。"
              )}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th>面接日時</th>
                    <th>候補者</th>
                    <th>面接官</th>
                    <th>録画</th>
                    <th>評価</th>
                    <th>状態</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((it) => (
                    <tr key={it.id} onClick={() => navigate(`/interviews/${it.id}`)} className="clickable">
                      <td className="num nowrap">{formatDateTime(it.scheduledAt ?? it.createdAt)}</td>
                      <td>
                        <Link to={`/interviews/${it.id}`} onClick={(e) => e.stopPropagation()}>
                          {it.candidate.displayName}
                        </Link>
                        {(it.candidate.kana || it.round) && (
                          <div className="muted small">
                            {it.candidate.kana}
                            {it.candidate.kana && it.round ? " ・ " : ""}
                            {it.round}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {it.interviewerIds.map((id) => names.get(id) ?? "—").join("・") || <span className="muted">未設定</span>}
                      </td>
                      <td className="small nowrap">
                        {it.recordingDeclined ? (
                          <span className="muted">録画なし(同意なし)</span>
                        ) : it.readyRecordingCount > 0 ? (
                          <>
                            {formatDuration(it.durationMs)}
                            {it.consent && !it.consent.analysis && <div className="muted">計測なし</div>}
                          </>
                        ) : it.recordingCount > 0 ? (
                          <span className="warn-text">送信中</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small nowrap">
                        <span className="num">
                          {it.submittedCount}/{it.expectedCount || "—"}
                        </span>
                        {it.votes && (it.votes.pass + it.votes.hold + it.votes.fail > 0) && (
                          <div className="vote-tally">
                            {it.votes.pass > 0 && <span className="vote vote-pass">合格 {it.votes.pass}</span>}
                            {it.votes.hold > 0 && <span className="vote vote-hold">保留 {it.votes.hold}</span>}
                            {it.votes.fail > 0 && <span className="vote vote-fail">不合格 {it.votes.fail}</span>}
                          </div>
                        )}
                        {it.score !== null && <div className="muted num">合計点 {formatScore(it.score)}</div>}
                        {it.myEvaluation === "draft" && <div className="muted">あなた: 下書き</div>}
                      </td>
                      <td className="nowrap">
                        {it.live ? (
                          <span className="chip chip-live">● ライブ</span>
                        ) : it.decision ? (
                          <VoteChip vote={it.decision.result} />
                        ) : (
                          <StatusChip status={it.status} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
