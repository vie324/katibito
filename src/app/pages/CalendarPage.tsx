// 面接の予定(1週間ごと)。日付は日本時間で区切る。自分が面接官の面接を目立たせ、
// 週の予定を .ics で各自のカレンダーアプリに取り込める。

import { useEffect, useMemo, useState } from "react";
import type { InterviewListItem } from "../../shared/types";
import { api, errorMessage } from "../api";
import { saveFile } from "../download";
import { formatTime, jstDateKey } from "../format";
import { buildIcs, interviewEvent, type IcsEvent } from "../ics";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Empty, Loading, Notice, StatusChip, VoteChip } from "../ui";

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 86_400_000;

// 日付は "YYYY-MM-DD"(日本時間)で扱い、計算は UTC の 0 時として行う(端末のタイムゾーンに左右されない)
const keyMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
const msKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (key: string, n: number) => msKey(keyMs(key) + n * DAY_MS);
const dowOf = (key: string) => new Date(keyMs(key)).getUTCDay();
const mondayOf = (key: string) => addDays(key, -((dowOf(key) + 6) % 7));

function label(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

function endTime(it: InterviewListItem): string | null {
  if (!it.scheduledAt || !it.plannedMinutes) return null;
  return formatTime(new Date(Date.parse(it.scheduledAt) + it.plannedMinutes * 60_000).toISOString());
}

export default function CalendarPage() {
  const { user, users, info } = useSession();
  const { navigate, search } = useRouter();
  const [items, setItems] = useState<InterviewListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = jstDateKey(new Date());
  const initial = search.get("w");
  const [week, setWeek] = useState(() => mondayOf(initial && /^\d{4}-\d{2}-\d{2}$/.test(initial) ? initial : today));
  const [mine, setMine] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .interviews()
        .then((r) => alive && (setItems(r.interviews), setError(null)))
        .catch((e) => alive && setError(errorMessage(e)));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const names = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);

  const visible = useMemo(
    () => (items ?? []).filter((it) => !mine || (user && it.interviewerIds.includes(user.id))),
    [items, mine, user],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, InterviewListItem[]>();
    for (const it of visible) {
      if (!it.scheduledAt) continue;
      const k = jstDateKey(it.scheduledAt);
      if (k < days[0] || k > days[6]) continue;
      const list = m.get(k) ?? [];
      list.push(it);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
    return m;
  }, [visible, days]);
  // 日時を決めずに登録した、まだ録画していない面接
  const undated = useMemo(() => visible.filter((it) => !it.scheduledAt && it.status === "scheduled"), [visible]);
  const weekCount = [...byDay.values()].reduce((s, l) => s + l.length, 0);

  const exportIcs = () => {
    const events = days
      .flatMap((d) => byDay.get(d) ?? [])
      .map((it) => interviewEvent(it, { orgName: info?.orgName ?? "", interviewerNames: it.interviewerIds.map((id) => names.get(id) ?? "") }))
      .filter((e): e is IcsEvent => e !== null);
    saveFile(buildIcs(events, `面接の予定 ${info?.orgName ?? ""}`.trim()), `面接の予定_${week}.ics`, "text/calendar;charset=utf-8");
  };

  if (error && !items) return <Notice kind="error">{error}</Notice>;
  if (!items) return <Loading />;

  return (
    <div className="page wide">
      <div className="page-head">
        <h2>予定</h2>
        <span className="spacer" />
        <button className="primary" onClick={() => navigate("/interviews/new")}>
          面接を登録
        </button>
      </div>

      <div className="cal-toolbar">
        <button className="quiet" onClick={() => setWeek(addDays(week, -7))}>
          ← 前の週
        </button>
        <button className="quiet" onClick={() => setWeek(mondayOf(today))} disabled={week === mondayOf(today)}>
          今週
        </button>
        <button className="quiet" onClick={() => setWeek(addDays(week, 7))}>
          次の週 →
        </button>
        <span className="cal-range num">
          {week.slice(0, 4)}年 {label(days[0])} 〜 {label(days[6])}
        </span>
        <span className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          <span>自分が面接官の面接だけ</span>
        </label>
        <button
          className="quiet"
          disabled={weekCount === 0}
          title="カレンダーアプリ(Google カレンダー・iPhone など)に取り込めるファイルです。候補者の表示名が含まれます"
          onClick={exportIcs}
        >
          この週を .ics で保存
        </button>
      </div>

      <div className="cal-week">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const dow = dowOf(d);
          return (
            <section key={d} className={`cal-day ${d === today ? "today" : ""} ${dow === 0 || dow === 6 ? "weekend" : ""} ${d < today ? "past" : ""}`}>
              <header className="cal-day-head">
                <span className="cal-dow">{DOW[dow]}</span>
                <span className="num">{label(d)}</span>
                {d === today && <span className="cal-today">今日</span>}
              </header>
              {list.length === 0 && <div className="cal-empty">—</div>}
              {list.map((it) => {
                const isMine = !!user && it.interviewerIds.includes(user.id);
                const end = endTime(it);
                return (
                  <Link key={it.id} to={`/interviews/${it.id}`} className={`cal-item ${isMine ? "mine" : ""}`}>
                    <div className="cal-time num">
                      {formatTime(it.scheduledAt)}
                      {end && <span className="muted">–{end}</span>}
                    </div>
                    <div className="cal-name">{it.candidate.displayName}</div>
                    {(it.round || it.location) && <div className="muted small">{[it.round, it.location].filter(Boolean).join(" ・ ")}</div>}
                    <div className="muted small">{it.interviewerIds.map((id) => names.get(id) ?? "—").join("・") || "面接官 未設定"}</div>
                    <div className="cal-status">
                      {it.live ? <span className="chip chip-live">● ライブ</span> : it.decision ? <VoteChip vote={it.decision.result} /> : <StatusChip status={it.status} />}
                    </div>
                  </Link>
                );
              })}
            </section>
          );
        })}
      </div>

      {undated.length > 0 && (
        <div className="panel cal-undated">
          <div className="panel-title">日時が決まっていない面接</div>
          {undated.map((it) => (
            <Link key={it.id} to={`/interviews/${it.id}`} className="todo-row">
              <span className="todo-name">{it.candidate.displayName}</span>
              {it.round && <span className="muted">{it.round}</span>}
              <span className="spacer" />
              <span className="muted small">日時を入れると予定に表示されます</span>
            </Link>
          ))}
        </div>
      )}
      {weekCount === 0 && undated.length === 0 && <Empty>この週の面接はありません。</Empty>}
    </div>
  );
}
