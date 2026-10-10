// 横断検索の結果。面接ごとにまとめ、見つかった箇所(候補者の情報・メモ・評価のコメント・文字起こし)を並べる。
// メモと文字起こしは、押すとその場面から再生する。

import { useEffect, useState, type FormEvent } from "react";
import type { SearchHit, SearchResult } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatClock, formatDateTime } from "../format";
import { Link, useRouter } from "../router";
import { Empty, Loading, Notice } from "../ui";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  candidate: "候補者",
  note: "メモ",
  evaluation: "評価のコメント",
  transcript: "文字起こし",
};

function highlight(text: string, q: string) {
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: (string | JSX.Element)[] = [];
  let pos = 0;
  for (let i = lower.indexOf(needle); i >= 0 && needle; i = lower.indexOf(needle, pos)) {
    if (i > pos) parts.push(text.slice(pos, i));
    parts.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    pos = i + needle.length;
  }
  parts.push(text.slice(pos));
  return parts;
}

function hitLink(iid: string, h: SearchHit): string {
  return h.recordingId && h.tMs !== null
    ? `/interviews/${iid}?rec=${encodeURIComponent(h.recordingId)}&t=${Math.floor(h.tMs / 1000)}`
    : `/interviews/${iid}`;
}

export default function SearchPage() {
  const { search, navigate } = useRouter();
  const q = (search.get("q") ?? "").trim();
  const [input, setInput] = useState(q);
  const [res, setRes] = useState<{ results: SearchResult[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(q);
    setRes(null);
    setError(null);
    if (!q) return;
    let alive = true;
    api
      .search(q)
      .then((r) => alive && setRes(r))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (v) navigate(`/search?q=${encodeURIComponent(v)}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>さがす</h2>
      </div>
      <form className="search-form" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={50} placeholder="名前・メモ・評価のコメント・話した内容" aria-label="さがすことば" autoFocus />
        <button className="primary">さがす</button>
      </form>
      <p className="muted small">
        見られる面接の、候補者の情報・メモ・評価のコメント・文字起こしから探します。まだ見られない(自分の評価を出す前の)ほかの人のメモと評価は探しません。
      </p>

      {error && <Notice kind="error">{error}</Notice>}
      {q && !res && !error && <Loading />}
      {res && res.results.length === 0 && <Empty>「{q}」は見つかりませんでした。</Empty>}
      {res && res.results.length > 0 && (
        <>
          <div className="muted small search-count">
            {res.results.length}件の面接{res.truncated ? "(多いため、新しい順に 50 件まで表示しています)" : ""}
          </div>
          <div className="search-results">
            {res.results.map((r) => (
              <section key={r.interviewId} className="panel search-result">
                <div className="search-head">
                  <Link to={`/interviews/${r.interviewId}`} className="search-name">
                    {r.candidate.displayName}
                  </Link>
                  <span className="muted small">
                    {r.candidate.kana}
                    {r.round ? ` ・ ${r.round}` : ""} ・ {formatDateTime(r.scheduledAt ?? r.createdAt)}
                  </span>
                  {r.total > r.hits.length && <span className="muted small">ほか {r.total - r.hits.length} 件</span>}
                </div>
                <ul className="search-hits">
                  {r.hits.map((h, i) => (
                    <li key={i}>
                      <Link to={hitLink(r.interviewId, h)} className="search-hit">
                        <span className="search-kind">
                          {KIND_LABEL[h.kind]}
                          {h.tMs !== null && <span className="num"> {formatClock(h.tMs)}</span>}
                        </span>
                        <span className="search-text">{highlight(h.text, q)}</span>
                        {h.who && <span className="muted small">{h.who}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
