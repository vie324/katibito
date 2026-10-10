// 横断検索: 見られる面接の中から、候補者の情報・メモ・評価のコメント・文字起こしをことばで探す。
// 評価の非公開のルールに従い、まだ見られないほかの人のメモ・評価は探さない
// (管理者も、自分の評価を出す前は画面と同じく伏せる)。

import type { SearchHit, SearchResult } from "../../src/shared/types";
import { str } from "../../src/shared/validate";
import { canView } from "../access";
import type { AppContext } from "../context";
import type { Router } from "../http";
import { readTranscript } from "../transcribe";
import { audit, evaluationVisibility } from "./interviews";

const MAX_RESULTS = 50;
const MAX_HITS = 5;

/** 見つかった箇所の前後を切り出す */
export function snippet(text: string, q: string, around = 32): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, around * 2);
  const start = Math.max(0, i - around);
  const end = Math.min(flat.length, i + q.length + around);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function registerSearchRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/search", "user", async (c) => {
    const q = str(c.query.get("q") ?? "", "検索することば", { max: 50, min: 1 }).trim();
    const needle = q.toLowerCase();
    const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(needle);
    const user = c.user!;
    const ivs = [...store.interviews.values()]
      .filter((iv) => canView(app, user, iv))
      .sort((a, b) => (b.scheduledAt ?? b.createdAt).localeCompare(a.scheduledAt ?? a.createdAt));

    const results: SearchResult[] = [];
    let truncated = false;
    for (const iv of ivs) {
      const hits: SearchHit[] = [];
      const add = (h: Omit<SearchHit, "recordingId" | "tMs" | "who"> & Partial<SearchHit>) =>
        hits.push({ recordingId: null, tMs: null, who: null, ...h });

      for (const t of [iv.candidate.displayName, iv.candidate.kana, iv.round, iv.location, iv.candidate.note]) {
        if (has(t)) {
          add({ kind: "candidate", text: snippet(t, q) });
          break;
        }
      }

      const evals = store.evaluationsOf(iv.id);
      const mine = evals.find((e) => e.userId === user.id) ?? null;
      const vis = evaluationVisibility(app, iv, user, mine);
      const othersOk = vis.visible && !vis.becauseAdmin;

      for (const n of store.notesOf(iv.id)) {
        if (n.userId !== user.id && n.kind !== "room" && !othersOk) continue;
        if (has(n.text)) add({ kind: "note", text: snippet(n.text, q), recordingId: n.recordingId, tMs: n.tMs, who: store.userName(n.userId) });
      }
      for (const e of evals) {
        if (e.userId !== user.id && (!othersOk || e.status !== "submitted")) continue;
        for (const t of [e.comment, ...Object.values(e.criterionComments ?? {})]) {
          if (has(t)) add({ kind: "evaluation", text: snippet(t, q), who: store.userName(e.userId) });
        }
      }
      for (const rec of iv.recordings) {
        if (rec.transcript !== "ready" || rec.status === "deleted" || rec.status === "purged") continue;
        const tr = await readTranscript(app, iv.id, rec.id).catch(() => null);
        for (const s of tr?.segments ?? []) {
          if (!has(s.text)) continue;
          add({ kind: "transcript", text: snippet(s.text, q), recordingId: rec.id, tMs: s.startMs });
          if (hits.length >= MAX_HITS * 4) break;
        }
      }

      if (hits.length === 0) continue;
      results.push({
        interviewId: iv.id,
        candidate: { displayName: iv.candidate.displayName, kana: iv.candidate.kana },
        round: iv.round,
        scheduledAt: iv.scheduledAt,
        createdAt: iv.createdAt,
        total: hits.length,
        hits: hits.slice(0, MAX_HITS),
      });
      if (results.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
    }
    await audit(app, c, "search", null, q);
    return { results, truncated };
  });
}
