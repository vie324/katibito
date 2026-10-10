// ファイルベースのデータストア。DATA_DIR 以下にすべて置く(バックアップはディレクトリごとコピー)。
//
//   users.json / sessions.json / settings.json
//   audit/YYYY-MM.jsonl
//   interviews/<id>/interview.json
//   interviews/<id>/evaluations/<userId>.json
//   interviews/<id>/notes.json
//   interviews/<id>/recordings/<rid>/{chunks/, video.*, track.bin.gz, summary.json}
//
// 面接の削除はディレクトリごと消す(残骸が残らないことを確認しやすい)。
// 書き込みは一時ファイル + rename で原子的に行い、同じ面接への読み書きはロックで直列化する。

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TEMPLATE_ID, defaultNotifyPrefs, defaultSettings, defaultTemplate } from "../src/shared/defaults";
import type { Criterion, Evaluation, Interview, InterviewTemplate, Note, NotifyPrefs, Settings, UserAccount, UserPublic } from "../src/shared/types";
import { ID_RE } from "../src/shared/validate";

export type UserRecord = UserPublic & {
  passwordHash: string;
  passwordChangedAt: string;
  /** お知らせを送るメールアドレス(空なら送らない) */
  email: string;
  notify: NotifyPrefs;
  /** 2段階認証(有効なら) */
  totp: TotpRecord | null;
  /** 設定の途中(確認コードを入れるまで有効にしない) */
  totpPending: { secret: string; createdAt: string } | null;
};

export type TotpRecord = {
  secret: string;
  enabledAt: string;
  /** 最後に使った時間刻み(同じコードの使い回しを防ぐ) */
  lastStep: number;
  /** 予備のコードのハッシュ(使うと消える) */
  recovery: string[];
};

export type SessionRecord = {
  userId: string;
  createdAt: number;
  expiresAt: number;
};

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export class Store {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  settings: Settings = defaultSettings();
  readonly interviews = new Map<string, Interview>();
  private readonly evaluations = new Map<string, Map<string, Evaluation>>();
  private readonly notes = new Map<string, Note[]>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private sessionsDirty: ReturnType<typeof setTimeout> | null = null;

  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<Store> {
    const s = new Store(path.resolve(dir));
    await s.load();
    return s;
  }

  // ------------------------------------------------------------------ paths

  get interviewsDir(): string {
    return path.join(this.dir, "interviews");
  }

  interviewDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid id: ${id}`);
    return path.join(this.interviewsDir, id);
  }

  recordingDir(id: string, rid: string): string {
    if (!ID_RE.test(rid)) throw new Error(`invalid id: ${rid}`);
    return path.join(this.interviewDir(id), "recordings", rid);
  }

  // ------------------------------------------------------------------ load

  private async load(): Promise<void> {
    await mkdir(this.interviewsDir, { recursive: true });
    await mkdir(path.join(this.dir, "audit"), { recursive: true });

    const users = (await readJsonFile<UserRecord[]>(path.join(this.dir, "users.json"))) ?? [];
    for (const u of users) {
      // v0.2 までの利用者にはメールの項目がない
      this.users.set(u.id, {
        ...u,
        email: u.email ?? "",
        notify: { ...defaultNotifyPrefs(u.role), ...(u.notify ?? {}) },
        totp: u.totp ?? null,
        totpPending: u.totpPending ?? null,
      });
    }

    const sessions =
      (await readJsonFile<Record<string, SessionRecord>>(path.join(this.dir, "sessions.json"))) ?? {};
    const now = Date.now();
    for (const [k, v] of Object.entries(sessions)) {
      if (v.expiresAt > now && this.users.has(v.userId)) this.sessions.set(k, v);
    }

    const settings = await readJsonFile<Partial<Settings>>(path.join(this.dir, "settings.json"));
    if (settings) this.settings = mergeSettings(settings);

    for (const entry of await readdir(this.interviewsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const dir = path.join(this.interviewsDir, entry.name);
      const iv = await readJsonFile<Interview>(path.join(dir, "interview.json"));
      if (!iv) continue;
      this.interviews.set(iv.id, normalizeInterview(iv, this.settings));
      const evMap = new Map<string, Evaluation>();
      try {
        for (const f of await readdir(path.join(dir, "evaluations"))) {
          if (!f.endsWith(".json")) continue;
          const ev = await readJsonFile<Evaluation>(path.join(dir, "evaluations", f));
          if (ev) evMap.set(ev.userId, ev);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      this.evaluations.set(iv.id, evMap);
      this.notes.set(iv.id, (await readJsonFile<Note[]>(path.join(dir, "notes.json"))) ?? []);
    }
  }

  // ------------------------------------------------------------------ lock

  /** 同じキーの処理を直列化する */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(key, chained);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  // ------------------------------------------------------------------ users

  async saveUsers(): Promise<void> {
    await writeJsonAtomic(path.join(this.dir, "users.json"), [...this.users.values()]);
  }

  userByLogin(loginId: string): UserRecord | undefined {
    const key = loginId.toLowerCase();
    for (const u of this.users.values()) if (u.loginId.toLowerCase() === key) return u;
    return undefined;
  }

  /** 本人と管理者に見せる情報(メールアドレスとお知らせの設定を含む) */
  accountView(u: UserRecord): UserAccount {
    return { ...this.publicUser(u), email: u.email, notify: { ...u.notify }, totpEnabled: !!u.totp };
  }

  publicUser(u: UserRecord): UserPublic {
    return {
      id: u.id,
      loginId: u.loginId,
      name: u.name,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt,
    };
  }

  userName(id: string): string {
    return this.users.get(id)?.name ?? "(削除されたユーザー)";
  }

  // ------------------------------------------------------------------ sessions

  scheduleSessionsSave(): void {
    if (this.sessionsDirty) return;
    this.sessionsDirty = setTimeout(() => {
      this.sessionsDirty = null;
      void this.saveSessions().catch((e) => console.error("[store] sessions の保存に失敗", e));
    }, 500);
  }

  async saveSessions(): Promise<void> {
    if (this.sessionsDirty) {
      clearTimeout(this.sessionsDirty);
      this.sessionsDirty = null;
    }
    await writeJsonAtomic(path.join(this.dir, "sessions.json"), Object.fromEntries(this.sessions));
  }

  // ------------------------------------------------------------------ settings

  async saveSettings(): Promise<void> {
    await writeJsonAtomic(path.join(this.dir, "settings.json"), this.settings);
  }

  // ------------------------------------------------------------------ interviews

  async saveInterview(iv: Interview): Promise<void> {
    const dir = this.interviewDir(iv.id);
    await mkdir(dir, { recursive: true });
    iv.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(dir, "interview.json"), iv);
    this.interviews.set(iv.id, iv);
    if (!this.evaluations.has(iv.id)) this.evaluations.set(iv.id, new Map());
    if (!this.notes.has(iv.id)) this.notes.set(iv.id, []);
  }

  async deleteInterview(id: string): Promise<void> {
    await rm(this.interviewDir(id), { recursive: true, force: true });
    this.interviews.delete(id);
    this.evaluations.delete(id);
    this.notes.delete(id);
  }

  // ------------------------------------------------------------------ evaluations

  evaluationsOf(interviewId: string): Evaluation[] {
    return [...(this.evaluations.get(interviewId)?.values() ?? [])];
  }

  evaluationOf(interviewId: string, userId: string): Evaluation | null {
    return this.evaluations.get(interviewId)?.get(userId) ?? null;
  }

  async saveEvaluation(interviewId: string, ev: Evaluation): Promise<void> {
    const dir = path.join(this.interviewDir(interviewId), "evaluations");
    await mkdir(dir, { recursive: true });
    if (!ID_RE.test(ev.userId)) throw new Error("invalid user id");
    await writeJsonAtomic(path.join(dir, `${ev.userId}.json`), ev);
    let m = this.evaluations.get(interviewId);
    if (!m) {
      m = new Map();
      this.evaluations.set(interviewId, m);
    }
    m.set(ev.userId, ev);
  }

  // ------------------------------------------------------------------ notes

  notesOf(interviewId: string): Note[] {
    return this.notes.get(interviewId) ?? [];
  }

  async saveNotes(interviewId: string, notes: Note[]): Promise<void> {
    await writeJsonAtomic(path.join(this.interviewDir(interviewId), "notes.json"), notes);
    this.notes.set(interviewId, notes);
  }
}

/** v0.2 までの設定(評価項目と質問が1組だけ) */
type LegacyCriterion = Omit<Criterion, "weight"> & { weight?: number };
type LegacySettings = Partial<Settings> & {
  criteria?: LegacyCriterion[];
  defaultQuestions?: string[];
};

function normalizeCriteria(list: LegacyCriterion[]): Criterion[] {
  return list.map((c) => ({ ...c, description: c.description ?? "", weight: typeof c.weight === "number" && c.weight > 0 ? c.weight : 1 }));
}

/** 保存済みの設定に、後から増えた項目の初期値を補う(古い形式の評価項目・質問は「標準」の評価シートにする) */
export function mergeSettings(saved: LegacySettings): Settings {
  const d = defaultSettings();
  let templates: InterviewTemplate[];
  if (Array.isArray(saved.templates) && saved.templates.length > 0) {
    templates = saved.templates.map((t) => ({
      ...t,
      criteria: normalizeCriteria(t.criteria ?? []),
      questions: (t.questions ?? []).map((q) => ({ text: q.text, minutes: q.minutes ?? null })),
      passLine: t.passLine ?? null,
    }));
  } else {
    const base = defaultTemplate();
    templates = [
      {
        ...base,
        criteria: saved.criteria ? normalizeCriteria(saved.criteria) : base.criteria,
        questions: saved.defaultQuestions ? saved.defaultQuestions.map((text) => ({ text, minutes: null })) : base.questions,
      },
    ];
  }
  const { criteria: _c, defaultQuestions: _q, ...rest } = saved;
  void _c;
  void _q;
  return {
    ...d,
    ...rest,
    templates,
    defaultTemplateId: templates.some((t) => t.id === saved.defaultTemplateId) ? saved.defaultTemplateId! : templates[0].id,
    consent: { ...d.consent, ...(saved.consent ?? {}) },
    retention: { ...d.retention, ...(saved.retention ?? {}) },
    recording: { ...d.recording, ...(saved.recording ?? {}) },
    access: { ...d.access, ...(saved.access ?? {}) },
    security: { ...d.security, ...(saved.security ?? {}) },
    reminders: { ...d.reminders, ...(saved.reminders ?? {}) },
    transcription: { ...d.transcription, ...(saved.transcription ?? {}) },
    notices: { ...d.notices, ...(saved.notices ?? {}) },
    ratingLabels: saved.ratingLabels ?? d.ratingLabels,
  };
}

/** 評価シートを選ぶ(見つからなければ既定のもの) */
export function templateOf(settings: Settings, id: string | null | undefined): InterviewTemplate {
  return (
    settings.templates.find((t) => t.id === id) ??
    settings.templates.find((t) => t.id === settings.defaultTemplateId) ??
    settings.templates[0]
  );
}

function normalizeInterview(iv: Interview, settings: Settings): Interview {
  const questions = iv.questions ?? [];
  // v0.2 までの面接は評価項目の写しを持たない。保存時点の設定(既定の評価シート)を写す
  const legacyTemplate = iv.criteria ? null : templateOf(settings, DEFAULT_TEMPLATE_ID);
  return {
    ...iv,
    applicantId: iv.applicantId ?? iv.id,
    round: iv.round ?? "",
    location: iv.location ?? "",
    interviewerIds: iv.interviewerIds ?? [],
    questions,
    questionMinutes: questions.map((_, i) => iv.questionMinutes?.[i] ?? null),
    templateId: iv.templateId ?? legacyTemplate?.id ?? null,
    templateName: iv.templateName ?? legacyTemplate?.name ?? "",
    criteria: iv.criteria ? normalizeCriteria(iv.criteria) : legacyTemplate!.criteria.map((c) => ({ ...c })),
    passLine: iv.passLine ?? null,
    recordingDeclined: iv.recordingDeclined ?? false,
    recordings: (iv.recordings ?? []).map((r) => ({
      ...r,
      markers: r.markers ?? [],
      originalName: r.originalName ?? null,
      mp4Ready: r.mp4Ready ?? false,
      transcript: r.transcript ?? "none",
      transcriptError: r.transcriptError ?? null,
      error: r.error ?? null,
      purgedAt: r.purgedAt ?? null,
    })),
    decision: iv.decision ?? null,
    consent: iv.consent ?? null,
    attachments: iv.attachments ?? [],
    consentLinks: iv.consentLinks ?? [],
  };
}
