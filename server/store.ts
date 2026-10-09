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
import { defaultSettings } from "../src/shared/defaults";
import type { Evaluation, Interview, Note, Settings, UserPublic } from "../src/shared/types";
import { ID_RE } from "../src/shared/validate";

export type UserRecord = UserPublic & { passwordHash: string; passwordChangedAt: string };

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
    for (const u of users) this.users.set(u.id, u);

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
      this.interviews.set(iv.id, normalizeInterview(iv));
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

/** 保存済みの設定に、後から増えた項目の初期値を補う */
export function mergeSettings(saved: Partial<Settings>): Settings {
  const d = defaultSettings();
  return {
    ...d,
    ...saved,
    consent: { ...d.consent, ...(saved.consent ?? {}) },
    retention: { ...d.retention, ...(saved.retention ?? {}) },
    recording: { ...d.recording, ...(saved.recording ?? {}) },
    criteria: saved.criteria ?? d.criteria,
    ratingLabels: saved.ratingLabels ?? d.ratingLabels,
    defaultQuestions: saved.defaultQuestions ?? d.defaultQuestions,
  };
}

function normalizeInterview(iv: Interview): Interview {
  return {
    ...iv,
    location: iv.location ?? "",
    interviewerIds: iv.interviewerIds ?? [],
    questions: iv.questions ?? [],
    recordingDeclined: iv.recordingDeclined ?? false,
    recordings: (iv.recordings ?? []).map((r) => ({
      ...r,
      markers: r.markers ?? [],
      originalName: r.originalName ?? null,
      mp4Ready: r.mp4Ready ?? false,
      error: r.error ?? null,
      purgedAt: r.purgedAt ?? null,
    })),
    decision: iv.decision ?? null,
    consent: iv.consent ?? null,
  };
}
