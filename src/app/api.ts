// API クライアント。サーバーのエラーメッセージ({ error })をそのまま例外にする。

import type { ExpressionSummary } from "../analysis/expression";
import type {
  AuditEntry,
  ExpressionStats,
  InterviewDetail,
  InterviewListItem,
  LiveInfo,
  Marker,
  Note,
  NotesView,
  QuestionPlan,
  RecordingMeta,
  SessionInfo,
  Settings,
  Transcript,
  TranscriptionStatus,
  UserPublic,
  Vote,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** 401 を受け取ったとき(セッション切れ)に呼ばれる */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: BodyInit; contentType?: string; signal?: AbortSignal; timeoutMs?: number; clientId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "katibito" };
  if (opts.clientId) headers["X-Recording-Client-Id"] = opts.clientId;
  let payload: BodyInit | undefined;
  if (opts.raw !== undefined) {
    payload = opts.raw;
    headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  if (opts.timeoutMs) signals.push(AbortSignal.timeout(opts.timeoutMs));
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw e;
    throw new ApiError(0, "サーバーに接続できません。ネットワークを確認してください");
  }
  if (res.status === 401 && path !== "/api/login" && path !== "/api/me/password") {
    for (const fn of unauthorizedListeners) fn();
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let message = `エラーが発生しました (${res.status})`;
    if (ct.includes("application/json")) {
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) message = j.error;
      } catch {
        // 本文を読めなければ既定の文言
      }
    } else if (res.status === 413) {
      message = "データが大きすぎます";
    } else if (res.status >= 502 && res.status <= 504) {
      message = "サーバーが応答しません。しばらく待ってから再度お試しください";
    }
    throw new ApiError(res.status, message);
  }
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.arrayBuffer()) as T;
}

const enc = encodeURIComponent;
const iv = (id: string) => `/api/interviews/${enc(id)}`;
const recPath = (id: string, rid: string) => `${iv(id)}/recordings/${enc(rid)}`;

export type ConsentInput = {
  recording: boolean;
  analysis: boolean;
  candidateName: string;
  guardianName: string;
  guardianRelation: string;
  method: "onscreen" | "paper";
  consentText: string;
};

export type InterviewInput = {
  candidate: { displayName: string; kana: string; age: number | null; minor: boolean; note: string };
  round: string;
  scheduledAt: string | null;
  location: string;
  interviewerIds: string[];
  questions: QuestionPlan[];
  templateId?: string;
  /** 同じ候補者の次の面接として登録する(前の面接のID) */
  fromInterviewId?: string;
};

export type EvaluationInput = {
  ratings: Record<string, number | null>;
  criterionComments: Record<string, string>;
  vote: Vote | null;
  comment: string;
  submit: boolean;
};

export const api = {
  session: () => request<SessionInfo>("GET", "/api/session"),
  setup: (b: { setupCode: string; orgName: string; loginId: string; name: string; password: string }) =>
    request<{ user: UserPublic }>("POST", "/api/setup", b),
  login: (loginId: string, password: string) =>
    request<{ user: UserPublic }>("POST", "/api/login", { loginId, password }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>("POST", "/api/me/password", { current, next }),

  users: () => request<{ users: UserPublic[] }>("GET", "/api/users"),
  createUser: (b: { loginId: string; name: string; role: string; password: string }) =>
    request<{ user: UserPublic }>("POST", "/api/users", b),
  updateUser: (id: string, b: Partial<{ name: string; role: string; disabled: boolean; password: string }>) =>
    request<{ user: UserPublic }>("PATCH", `/api/users/${enc(id)}`, b),

  settings: () => request<{ settings: Settings }>("GET", "/api/settings"),
  saveSettings: (s: Settings) => request<{ settings: Settings }>("PUT", "/api/settings", s),

  interviews: () => request<{ interviews: InterviewListItem[] }>("GET", "/api/interviews"),
  createInterview: (b: InterviewInput) => request<InterviewDetail>("POST", "/api/interviews", b),
  interview: (id: string) => request<InterviewDetail>("GET", iv(id)),
  updateInterview: (id: string, b: Partial<InterviewInput>) => request<InterviewDetail>("PATCH", iv(id), b),
  deleteInterview: (id: string) => request<{ ok: true }>("DELETE", iv(id)),

  recordConsent: (id: string, b: ConsentInput) => request<InterviewDetail>("POST", `${iv(id)}/consent`, b),
  withdrawConsent: (id: string, scope: "analysis" | "all") =>
    request<InterviewDetail>("POST", `${iv(id)}/consent/withdraw`, { scope }),

  saveEvaluation: (id: string, b: EvaluationInput) => request<InterviewDetail>("PUT", `${iv(id)}/evaluations/me`, b),
  addNote: (
    id: string,
    b: { recordingId: string | null; tMs: number | null; text: string; kind?: "note" | "room"; live?: boolean },
  ) => request<{ note: Note; notes: NotesView }>("POST", `${iv(id)}/notes`, b),
  roomMessages: (id: string, since: string | null) =>
    request<{ messages: Note[] }>("GET", `${iv(id)}/room-messages${since ? `?since=${enc(since)}` : ""}`),
  deleteNote: (id: string, noteId: string) =>
    request<{ notes: NotesView }>("DELETE", `${iv(id)}/notes/${enc(noteId)}`),

  decide: (id: string, result: Vote, reason: string) =>
    request<InterviewDetail>("PUT", `${iv(id)}/decision`, { result, reason }),
  cancelDecision: (id: string) => request<InterviewDetail>("DELETE", `${iv(id)}/decision`),

  createRecording: (
    id: string,
    b: { clientId: string; source: "live" | "file"; mimeType: string; startedAt: string; fileName?: string | null },
  ) => request<{ recording: RecordingMeta; received: number[] }>("POST", `${iv(id)}/recordings`, b),
  recording: (id: string, rid: string) =>
    request<{ recording: RecordingMeta; received: number[] }>("GET", recPath(id, rid)),
  // 録画の送信は、録画を作った端末の録画ID(clientId)を合言葉として添える
  putChunk: (id: string, rid: string, clientId: string, index: number, data: Blob, signal?: AbortSignal) =>
    request<{ ok: true }>("PUT", `${recPath(id, rid)}/chunks/${index}`, undefined, {
      raw: data,
      signal,
      timeoutMs: 5 * 60_000,
      clientId,
    }),
  completeRecording: (
    id: string,
    rid: string,
    clientId: string,
    b: { chunkCount: number; durationMs: number | null; endedAt: string; markers: Marker[] },
  ) => request<{ recording: RecordingMeta }>("POST", `${recPath(id, rid)}/complete`, b, { clientId }),
  putMarkers: (id: string, rid: string, markers: Marker[]) =>
    request<{ recording: RecordingMeta; summary: ExpressionSummary | null }>("PUT", `${recPath(id, rid)}/markers`, { markers }),
  putTrack: (id: string, rid: string, gz: Blob, clientId?: string) =>
    request<{ recording: RecordingMeta; summary: ExpressionSummary }>("PUT", `${recPath(id, rid)}/track`, undefined, {
      raw: gz,
      contentType: "application/gzip",
      timeoutMs: 5 * 60_000,
      clientId,
    }),
  trackGz: (id: string, rid: string) => request<ArrayBuffer>("GET", `${recPath(id, rid)}/track`),
  summary: (id: string, rid: string) => request<{ summary: ExpressionSummary }>("GET", `${recPath(id, rid)}/summary`),
  transcript: (id: string, rid: string) => request<{ transcript: Transcript }>("GET", `${recPath(id, rid)}/transcript`),
  requestTranscript: (id: string, rid: string) => request<{ recording: RecordingMeta }>("POST", `${recPath(id, rid)}/transcript`, {}),
  deleteRecording: (id: string, rid: string) => request<{ recording: RecordingMeta }>("DELETE", recPath(id, rid)),
  videoUrl: (id: string, rid: string) => `${recPath(id, rid)}/video`,
  mp4Url: (id: string, rid: string) => `${recPath(id, rid)}/video?format=mp4`,
  liveHeartbeat: (id: string, rid: string, clientId: string, b: { elapsedMs: number; question: string | null }) =>
    request<{ live: LiveInfo | null }>("POST", `${recPath(id, rid)}/live`, b, { clientId, timeoutMs: 10_000 }),
  liveChunk: (id: string, rid: string, index: number, signal?: AbortSignal) =>
    request<ArrayBuffer>("GET", `${recPath(id, rid)}/chunks/${index}`, undefined, { signal, timeoutMs: 30_000 }),
  abortRecording: (id: string, rid: string, clientId?: string) =>
    request<{ recording: RecordingMeta }>("POST", `${recPath(id, rid)}/abort`, {}, { clientId }),
  reprocessRecording: (id: string, rid: string) =>
    request<{ recording: RecordingMeta }>("POST", `${recPath(id, rid)}/reprocess`, {}),

  stats: () => request<ExpressionStats>("GET", "/api/stats/expression"),
  transcriptionStatus: () => request<{ status: TranscriptionStatus }>("GET", "/api/admin/transcription"),
  prepareTranscription: () => request<{ status: TranscriptionStatus }>("POST", "/api/admin/transcription/prepare", {}),
  audit: (limit = 300) => request<{ entries: AuditEntry[] }>("GET", `/api/audit?limit=${limit}`),
  runRetention: () => request<{ purged: number; staleRemoved: number }>("POST", "/api/admin/retention/run", {}),
  exportCsvUrl: "/api/export/interviews.csv",
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
