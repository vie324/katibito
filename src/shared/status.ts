// 面接の状態の導出(一覧・詳細で共通)。状態は保存せず、データから毎回求める。

import type { Evaluation, Interview, InterviewStatus, Vote } from "./types";

export function submittedEvaluations(evals: Iterable<Evaluation>): Evaluation[] {
  return [...evals].filter((e) => e.status === "submitted");
}

export function deriveStatus(interview: Interview, evals: Iterable<Evaluation>): InterviewStatus {
  if (interview.decision) return "decided";
  if (interview.recordings.some((r) => r.status === "uploading" || r.status === "processing")) {
    return "uploading";
  }
  const submitted = submittedEvaluations(evals);
  const hasMaterial =
    interview.recordingDeclined ||
    interview.recordings.some((r) => r.status === "ready" || r.status === "purged") ||
    submitted.length > 0;
  if (!hasMaterial) return "scheduled";
  const assigned = interview.interviewerIds;
  if (assigned.length > 0) {
    const done = new Set(submitted.map((e) => e.userId));
    if (assigned.every((id) => done.has(id))) return "deciding";
    return "evaluating";
  }
  return submitted.length > 0 ? "deciding" : "evaluating";
}

export function tallyVotes(evals: Iterable<Evaluation>): Record<Vote, number> {
  const t: Record<Vote, number> = { pass: 0, hold: 0, fail: 0 };
  for (const e of submittedEvaluations(evals)) {
    if (e.vote) t[e.vote]++;
  }
  return t;
}

export const STATUS_LABEL: Record<InterviewStatus, string> = {
  scheduled: "録画前",
  uploading: "録画を送信中",
  evaluating: "評価入力中",
  deciding: "判定待ち",
  decided: "判定済",
};

export const VOTE_LABEL: Record<Vote, string> = {
  pass: "合格",
  hold: "保留",
  fail: "不合格",
};
