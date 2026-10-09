// 面接・同意・評価・メモ・判定の API。

import { createHash } from "node:crypto";
import { deriveStatus, submittedEvaluations, tallyVotes } from "../../src/shared/status";
import type {
  Candidate,
  ConsentRecord,
  Decision,
  Evaluation,
  EvaluationsView,
  Interview,
  InterviewDetail,
  InterviewListItem,
  InterviewTemplate,
  Note,
  NotesView,
  QuestionPlan,
  RoundSummary,
  UserPublic,
  Vote,
} from "../../src/shared/types";
import { averageScore } from "../../src/shared/score";
import { arr, bool, id, int, isoDate, obj, oneOf, str, ValidationError } from "../../src/shared/validate";
import type { AppContext } from "../context";
import { HttpError, readJson, type Ctx, type Router } from "../http";
import { notifyDecision, notifyEvaluationSubmitted } from "../notifications";
import { deleteAnalysisFiles, deleteRecordingFiles, forgetSummary, liveInfo, publicRecording } from "../recordings";
import { newId, templateOf, type UserRecord } from "../store";
import { parseQuestionPlans } from "./account";

const VOTES = ["pass", "hold", "fail"] as const;

/**
 * この面接を見られるか。管理者はすべて。面接官は、設定で「担当の面接だけ」にしていれば
 * 面接官に選ばれた面接と自分が登録した面接だけ
 */
export function canView(app: AppContext, user: UserRecord, iv: Interview): boolean {
  if (user.role === "admin") return true;
  if (app.store.settings.access.interviewerScope === "all") return true;
  return iv.interviewerIds.includes(user.id) || iv.createdBy === user.id;
}

export function getInterview(app: AppContext, iid: string): Interview {
  const iv = app.store.interviews.get(iid);
  if (!iv) throw new HttpError(404, "面接が見つかりません");
  return iv;
}

const viewLogged = new WeakMap<AppContext, Map<string, number>>();

/** 閲覧の記録は同じ人・同じ面接につき10分に1回まで(画面の再読み込みで埋まらないように) */
export function auditView(app: AppContext, c: Ctx, action: string, interviewId: string, detail: string | null = null) {
  let m = viewLogged.get(app);
  if (!m) {
    m = new Map();
    viewLogged.set(app, m);
  }
  const key = `${c.user?.id}|${action}|${interviewId}|${detail ?? ""}`;
  const now = Date.now();
  const last = m.get(key) ?? 0;
  if (now - last < 10 * 60_000) return Promise.resolve();
  m.set(key, now);
  return audit(app, c, action, interviewId, detail);
}

export function audit(app: AppContext, c: Ctx, action: string, interviewId: string | null, detail: string | null = null) {
  return app.audit.write({
    userId: c.user?.id ?? null,
    userName: c.user?.name ?? null,
    action,
    interviewId,
    detail,
    ip: c.ip,
  });
}

// ---------------------------------------------------------------------------
// 評価の公開範囲
// ---------------------------------------------------------------------------

export function evaluationVisibility(
  app: AppContext,
  iv: Interview,
  user: UserRecord,
  mine: Evaluation | null,
): { visible: boolean; becauseAdmin: boolean; reason: string | null } {
  if (!app.store.settings.blindEvaluation) return { visible: true, becauseAdmin: false, reason: null };
  if (iv.decision) return { visible: true, becauseAdmin: false, reason: null };
  if (mine?.status === "submitted") return { visible: true, becauseAdmin: false, reason: null };
  if (user.role === "admin") return { visible: true, becauseAdmin: true, reason: null };
  return {
    visible: false,
    becauseAdmin: false,
    reason: "自分の評価を提出すると、ほかの評価者の評価とメモが表示されます",
  };
}

function evaluationsView(app: AppContext, iv: Interview, user: UserRecord): EvaluationsView {
  const all = app.store.evaluationsOf(iv.id);
  const mine = all.find((e) => e.userId === user.id) ?? null;
  const vis = evaluationVisibility(app, iv, user, mine);
  const othersSubmitted = all.filter((e) => e.userId !== user.id && e.status === "submitted");
  return {
    mine,
    others: vis.visible ? othersSubmitted.map((e) => ({ ...e, userName: app.store.userName(e.userId) })) : null,
    othersSubmittedCount: othersSubmitted.length,
    othersVisible: vis.visible,
    visibleBecauseAdmin: vis.becauseAdmin,
    hiddenReason: vis.reason,
  };
}

function notesView(app: AppContext, iv: Interview, user: UserRecord): NotesView {
  const all = app.store.notesOf(iv.id);
  const mine = app.store.evaluationOf(iv.id, user.id);
  const vis = evaluationVisibility(app, iv, user, mine);
  // 面接室へのメッセージは進行の連絡なので、評価の非公開の対象にしない
  const visible = vis.visible ? all : all.filter((n) => n.userId === user.id || n.kind === "room");
  return {
    notes: visible.map((n) => ({ ...n, userName: app.store.userName(n.userId) })),
    hiddenCount: all.length - visible.length,
  };
}

function otherRounds(app: AppContext, iv: Interview, user: UserRecord): RoundSummary[] {
  return [...app.store.interviews.values()]
    .filter((x) => x.applicantId === iv.applicantId && x.id !== iv.id && canView(app, user, x))
    .map((x) => ({
      id: x.id,
      round: x.round,
      scheduledAt: x.scheduledAt,
      createdAt: x.createdAt,
      status: deriveStatus(x, app.store.evaluationsOf(x.id)),
      decision: x.decision?.result ?? null,
    }))
    .sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
}

export function buildDetail(app: AppContext, iv: Interview, user: UserRecord): InterviewDetail {
  const evals = app.store.evaluationsOf(iv.id);
  const interviewers: UserPublic[] = iv.interviewerIds
    .map((uid) => app.store.users.get(uid))
    .filter((u): u is UserRecord => !!u)
    .map((u) => app.store.publicUser(u));
  return {
    interview: { ...iv, recordings: iv.recordings.map((r) => publicRecording(r, liveInfo(app, iv.id, r))) },
    status: deriveStatus(iv, evals),
    otherRounds: otherRounds(app, iv, user),
    interviewers,
    evaluations: evaluationsView(app, iv, user),
    notes: notesView(app, iv, user),
    criteria: iv.criteria,
    ratingLabels: app.store.settings.ratingLabels,
  };
}

export function listItem(app: AppContext, iv: Interview, user: UserRecord): InterviewListItem {
  const evals = app.store.evaluationsOf(iv.id);
  const submitted = submittedEvaluations(evals);
  const mine = evals.find((e) => e.userId === user.id);
  const ready = iv.recordings.filter((r) => r.status === "ready");
  const vis = evaluationVisibility(app, iv, user, mine ?? null);
  return {
    id: iv.id,
    candidate: iv.candidate,
    applicantId: iv.applicantId,
    round: iv.round,
    scheduledAt: iv.scheduledAt,
    location: iv.location,
    interviewerIds: iv.interviewerIds,
    createdAt: iv.createdAt,
    status: deriveStatus(iv, evals),
    consent: iv.consent ? { recording: iv.consent.recording, analysis: iv.consent.analysis } : null,
    recordingDeclined: iv.recordingDeclined,
    recordingCount: iv.recordings.filter((r) => r.status !== "deleted").length,
    readyRecordingCount: ready.length,
    durationMs: ready.reduce((s, r) => s + (r.durationMs ?? 0), 0) || null,
    submittedCount: submitted.filter((e) => iv.interviewerIds.includes(e.userId)).length,
    expectedCount: iv.interviewerIds.length,
    live: iv.recordings.some((r) => liveInfo(app, iv.id, r) !== null),
    myEvaluation: mine ? mine.status : "none",
    // 非公開中は票の内訳も点数も見せない(管理者には一覧で見せる)
    votes: vis.visible ? tallyVotes(evals) : null,
    score: vis.visible ? averageScore(iv.criteria, evals) : null,
    templateName: iv.templateName,
    decision: iv.decision,
  };
}

// ---------------------------------------------------------------------------
// 入力の解析
// ---------------------------------------------------------------------------

/** 未成年として扱うか(保護者の同意が必要)。年齢が18歳未満なら、チェックの有無にかかわらず未成年 */
export function isMinor(c: Pick<Candidate, "age" | "minor">): boolean {
  return c.minor || (c.age !== null && c.age < 18);
}

function parseCandidate(v: unknown): Candidate {
  const o = obj(v, "候補者");
  const age = int(o.age, "年齢", { min: 0, max: 120, optional: true });
  const minor = (o.minor !== undefined && bool(o.minor, "未成年")) || (age !== null && age < 18);
  return {
    displayName: str(o.displayName, "候補者の表示名", { max: 60, min: 1 }),
    kana: str(o.kana, "ふりがな", { max: 60, optional: true }),
    age,
    minor,
    note: str(o.note, "メモ", { max: 1000, optional: true, multiline: true }),
  };
}

function parseInterviewers(app: AppContext, v: unknown): string[] {
  const ids = arr(v, "面接官", 10, (x) => id(x, "面接官"));
  for (const uid of ids) {
    if (!app.store.users.has(uid)) throw new ValidationError("存在しないユーザーが面接官に含まれています");
  }
  return [...new Set(ids)];
}

/** 質問リスト。文字列の配列(v0.2 まで)か、{ text, minutes } の配列 */
function parseQuestions(v: unknown): { questions: string[]; minutes: (number | null)[] } {
  const plans = arr(v, "質問", 30, (x, i): QuestionPlan => {
    if (typeof x === "string") return { text: str(x, `質問${i + 1}`, { max: 100, min: 1 }), minutes: null };
    return parseQuestionPlans([x], `質問${i + 1}`)[0];
  });
  return { questions: plans.map((q) => q.text), minutes: plans.map((q) => q.minutes) };
}

/** 評価シートの内容を面接に写す */
function applyTemplate(iv: Pick<Interview, "templateId" | "templateName" | "criteria" | "passLine">, t: InterviewTemplate): void {
  iv.templateId = t.id;
  iv.templateName = t.name;
  iv.criteria = t.criteria.map((c) => ({ ...c }));
  iv.passLine = t.passLine;
}

/** 録画の仕上げ(結合・索引付け)の最中は、ファイルを消す操作を受け付けない */
function refuseWhileFinalizing(app: AppContext, iv: Interview): void {
  if (iv.recordings.some((rec) => app.jobs.has(`finalize:${iv.id}:${rec.id}`))) {
    throw new HttpError(409, "録画を処理中です。1〜2分待ってからもう一度実行してください");
  }
}

export function registerInterviewRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/interviews", "user", (c) => {
    const items = [...store.interviews.values()].filter((iv) => canView(app, c.user!, iv)).map((iv) => listItem(app, iv, c.user!));
    items.sort((a, b) => (b.scheduledAt ?? b.createdAt).localeCompare(a.scheduledAt ?? a.createdAt));
    return { interviews: items };
  });

  r.post("/api/interviews", "user", async (c) => {
    const body = obj(await readJson(c));
    const now = new Date().toISOString();
    if (body.templateId !== undefined && body.templateId !== null && !store.settings.templates.some((t) => t.id === body.templateId)) {
      throw new ValidationError("評価シートが見つかりません");
    }
    const template = templateOf(store.settings, typeof body.templateId === "string" ? body.templateId : null);
    // 「次の面接を登録」: 前の面接と同じ候補者としてまとめる
    let applicantId = newId();
    if (body.fromInterviewId !== undefined && body.fromInterviewId !== null) {
      const from = store.interviews.get(id(body.fromInterviewId, "前の面接"));
      if (!from || !canView(app, c.user!, from)) throw new ValidationError("前の面接が見つかりません");
      applicantId = from.applicantId;
    }
    const q =
      body.questions === undefined
        ? { questions: template.questions.map((x) => x.text), minutes: template.questions.map((x) => x.minutes) }
        : parseQuestions(body.questions);
    const iv: Interview = {
      id: newId(),
      candidate: parseCandidate(body.candidate),
      applicantId,
      round: str(body.round, "面接の段階", { max: 20, optional: true }),
      scheduledAt: isoDate(body.scheduledAt, "面接日時"),
      location: str(body.location, "場所", { max: 100, optional: true }),
      interviewerIds: parseInterviewers(app, body.interviewerIds),
      questions: q.questions,
      questionMinutes: q.minutes,
      templateId: null,
      templateName: "",
      criteria: [],
      passLine: null,
      createdAt: now,
      createdBy: c.user!.id,
      updatedAt: now,
      consent: null,
      recordingDeclined: false,
      recordings: [],
      decision: null,
    };
    applyTemplate(iv, template);
    await store.saveInterview(iv);
    await audit(app, c, "interview_create", iv.id);
    return buildDetail(app, iv, c.user!);
  });

  r.get("/api/interviews/:id", "user", async (c) => {
    const iv = getInterview(app, c.params.id);
    await auditView(app, c, "interview_view", iv.id);
    return buildDetail(app, iv, c.user!);
  });

  r.patch("/api/interviews/:id", "user", async (c) => {
    const body = obj(await readJson(c));
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (iv.decision && c.user!.role !== "admin") throw new HttpError(409, "判定済みの面接は管理者のみ編集できます");
      // すべて検証してから反映する(途中で入力エラーになっても中途半端に変わらないように)
      const patch: Partial<Interview> = {};
      if (body.candidate !== undefined) patch.candidate = parseCandidate(body.candidate);
      if (body.scheduledAt !== undefined) patch.scheduledAt = isoDate(body.scheduledAt, "面接日時");
      if (body.location !== undefined) patch.location = str(body.location, "場所", { max: 100, optional: true });
      if (body.round !== undefined) patch.round = str(body.round, "面接の段階", { max: 20, optional: true });
      if (body.interviewerIds !== undefined) patch.interviewerIds = parseInterviewers(app, body.interviewerIds);
      if (body.questions !== undefined) {
        const q = parseQuestions(body.questions);
        patch.questions = q.questions;
        patch.questionMinutes = q.minutes;
      }
      if (body.templateId !== undefined && body.templateId !== iv.templateId) {
        const t = store.settings.templates.find((x) => x.id === body.templateId);
        if (!t) throw new ValidationError("評価シートが見つかりません");
        // 評価が入力されたあとに評価項目を入れ替えると、入力済みの評価と項目が合わなくなる
        if (store.evaluationsOf(iv.id).length > 0) {
          throw new HttpError(409, "評価が入力済みのため、評価シートは変更できません");
        }
        applyTemplate(patch as Interview, t);
      }
      Object.assign(iv, patch);
      await store.saveInterview(iv);
      await audit(app, c, "interview_update", iv.id);
      return buildDetail(app, iv, c.user!);
    });
  });

  r.delete("/api/interviews/:id", "admin", async (c) => {
    const iid = c.params.id;
    await store.withLock(iid, async () => {
      const iv = getInterview(app, iid);
      refuseWhileFinalizing(app, iv);
      await store.deleteInterview(iid);
      forgetSummary(app, iid);
    });
    await audit(app, c, "interview_delete", iid);
    return { ok: true };
  });

  // ---------------------------------------------------------------- 同意
  r.post("/api/interviews/:id/consent", "user", async (c) => {
    const body = obj(await readJson(c, 256 * 1024));
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (iv.decision) throw new HttpError(409, "判定済みの面接です");
      if (iv.recordings.some((rec) => rec.status !== "deleted")) {
        throw new HttpError(409, "すでに録画があるため、同意の記録は変更できません。取り消す場合は管理者に依頼してください");
      }
      const recording = bool(body.recording, "録画への同意");
      const analysis = bool(body.analysis, "表情の計測への同意");
      if (analysis && !recording) throw new ValidationError("表情の計測には録画への同意が必要です");
      const method = oneOf(body.method, "同意の方法", ["onscreen", "paper"] as const);
      const candidateName = str(body.candidateName, "本人の氏名", { max: 60, min: recording ? 1 : 0, optional: !recording });
      const guardianName = str(body.guardianName, "保護者の氏名", { max: 60, optional: true });
      if (recording && isMinor(iv.candidate) && !guardianName) {
        throw new ValidationError("未成年の候補者は保護者の同意(氏名)が必要です");
      }
      const consentText = str(body.consentText, "同意文", { max: 20_000, min: 10, multiline: true });
      const consent: ConsentRecord = {
        recording,
        analysis,
        candidateName,
        guardianName: guardianName || null,
        guardianRelation: str(body.guardianRelation, "続柄", { max: 20, optional: true }) || null,
        method,
        consentVersion: createHash("sha256").update(consentText).digest("hex").slice(0, 12),
        consentText,
        obtainedBy: c.user!.id,
        obtainedByName: c.user!.name,
        obtainedAt: new Date().toISOString(),
        withdrawnAt: null,
        withdrawnScope: null,
      };
      iv.consent = consent;
      iv.recordingDeclined = !recording;
      await store.saveInterview(iv);
      await audit(app, c, "consent_record", iv.id, `recording=${recording} analysis=${analysis} method=${method}`);
      return buildDetail(app, iv, c.user!);
    });
  });

  r.post("/api/interviews/:id/consent/withdraw", "admin", async (c) => {
    const body = obj(await readJson(c));
    const scope = oneOf(body.scope, "取り消しの範囲", ["analysis", "all"] as const);
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (!iv.consent) throw new HttpError(409, "同意の記録がありません");
      refuseWhileFinalizing(app, iv);
      for (const rec of iv.recordings) {
        if (rec.status === "deleted") continue;
        if (scope === "all") {
          await deleteRecordingFiles(app, iv.id, rec, false);
          rec.status = "deleted";
          rec.fileName = null;
          rec.analysis = "none";
          rec.purgedAt = new Date().toISOString();
        } else if (rec.analysis !== "none") {
          // 映像は残し、顔トラックと集計だけ消す
          await deleteAnalysisFiles(app, iv.id, rec);
          rec.analysis = "none";
        }
      }
      forgetSummary(app, iv.id);
      iv.consent = {
        ...iv.consent,
        analysis: false,
        recording: scope === "all" ? false : iv.consent.recording,
        withdrawnAt: new Date().toISOString(),
        withdrawnScope: scope,
      };
      await store.saveInterview(iv);
      await audit(app, c, "consent_withdraw", iv.id, scope);
      return buildDetail(app, iv, c.user!);
    });
  });

  // ---------------------------------------------------------------- 評価
  r.put("/api/interviews/:id/evaluations/me", "user", async (c) => {
    const body = obj(await readJson(c, 256 * 1024));
    const user = c.user!;
    let submittedNow = false;
    const detail = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (iv.decision) throw new HttpError(409, "判定済みのため評価は変更できません");
      const criteria = iv.criteria;
      const ratingsIn = body.ratings === undefined ? {} : obj(body.ratings, "評価");
      const commentsIn = body.criterionComments === undefined ? {} : obj(body.criterionComments, "項目ごとのコメント");
      const ratings: Record<string, number | null> = {};
      const criterionComments: Record<string, string> = {};
      for (const cr of criteria) {
        ratings[cr.id] = int(ratingsIn[cr.id], cr.label, { min: 1, max: 5, optional: true });
        const cm = str(commentsIn[cr.id], `${cr.label}のコメント`, { max: 1000, optional: true, multiline: true });
        if (cm) criterionComments[cr.id] = cm;
      }
      const vote = body.vote === null || body.vote === undefined ? null : oneOf(body.vote, "総合評価", VOTES);
      const comment = str(body.comment, "コメント", { max: 4000, optional: true, multiline: true });
      const submit = bool(body.submit, "提出", false);
      if (submit) {
        const missing = criteria.filter((cr) => ratings[cr.id] === null).map((cr) => cr.label);
        if (missing.length > 0) throw new ValidationError(`未入力の項目があります: ${missing.join("、")}`);
        if (!vote) throw new ValidationError("総合評価(合格・保留・不合格)を選んでください");
      }
      const prev = store.evaluationOf(iv.id, user.id);
      const now = new Date().toISOString();
      const wasSubmitted = prev?.status === "submitted";
      // 提出後の修正は回数と日時を残し、ほかの評価者・管理者にも見せる
      // (先に仮の評価を提出して、ほかの人の評価を見てから書き換えた、が分かるように)
      const changed =
        wasSubmitted &&
        (JSON.stringify(prev.ratings) !== JSON.stringify(ratings) ||
          JSON.stringify(prev.criterionComments) !== JSON.stringify(criterionComments) ||
          prev.vote !== vote ||
          prev.comment !== comment);
      const othersVisible =
        changed && store.evaluationsOf(iv.id).some((e) => e.userId !== user.id && e.status === "submitted");
      const ev: Evaluation = {
        userId: user.id,
        userName: user.name,
        ratings,
        criterionComments,
        vote,
        comment,
        status: submit || wasSubmitted ? "submitted" : "draft",
        updatedAt: now,
        submittedAt: wasSubmitted ? prev.submittedAt : submit ? now : null,
        revisions: (prev?.revisions ?? 0) + (changed ? 1 : 0),
        revisedAt: changed ? now : (prev?.revisedAt ?? null),
        revisedWhileOthersVisible: Boolean(prev?.revisedWhileOthersVisible) || othersVisible,
      };
      // 提出済みを下書き保存で取り下げることはできない(下書き保存 = 内容の更新のみ)
      if (!submit && prev?.status === "submitted") {
        if (!vote) throw new ValidationError("提出済みの評価は総合評価を空にできません");
      }
      submittedNow = submit && prev?.status !== "submitted";
      await store.saveEvaluation(iv.id, ev);
      await audit(app, c, changed ? "evaluation_revise" : submit ? "evaluation_submit" : "evaluation_save", iv.id);
      return buildDetail(app, iv, user);
    });
    if (submittedNow) {
      const iv = store.interviews.get(c.params.id);
      if (iv) {
        const submitted = submittedEvaluations(store.evaluationsOf(iv.id)).filter((e) =>
          iv.interviewerIds.includes(e.userId),
        ).length;
        void notifyEvaluationSubmitted(app, iv, user.name, submitted, iv.interviewerIds.length);
      }
    }
    return detail;
  });

  // ---------------------------------------------------------------- メモ
  r.post("/api/interviews/:id/notes", "user", async (c) => {
    const body = obj(await readJson(c));
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const kind = body.kind === undefined ? "note" : oneOf(body.kind, "メモの種類", ["note", "room"] as const);
      const recordingId = body.recordingId === null || body.recordingId === undefined ? null : id(body.recordingId, "録画");
      const rec = recordingId ? iv.recordings.find((x) => x.id === recordingId) : undefined;
      if (recordingId && !rec) throw new ValidationError("録画が見つかりません");
      let tMs: number | null = null;
      if (rec && body.live === true) {
        // ライブで見ながらのメモ: 時刻はサーバーが録画の経過時間から決める(端末の時計に頼らない)
        const live = liveInfo(app, iv.id, rec);
        if (!live) throw new HttpError(409, "録画は終わっています。メモは録画の再生画面から追加してください");
        tMs = live.elapsedMs;
      } else if (rec) {
        tMs = int(body.tMs, "時刻", { min: 0, max: 24 * 3600_000 });
      }
      const note: Note = {
        id: newId(9),
        kind,
        recordingId,
        tMs,
        text: str(body.text, kind === "room" ? "メッセージ" : "メモ", { max: 2000, min: 1, multiline: true }),
        userId: c.user!.id,
        userName: c.user!.name,
        createdAt: new Date().toISOString(),
      };
      const notes = [...store.notesOf(iv.id), note];
      if (notes.length > 2000) throw new HttpError(409, "メモの件数が上限に達しています");
      await store.saveNotes(iv.id, notes);
      if (kind === "room") await audit(app, c, "room_message", iv.id);
      return { note, notes: notesView(app, iv, c.user!) };
    });
  });

  // 録画している端末が、面接室へのメッセージを受け取る
  r.get("/api/interviews/:id/room-messages", "user", (c) => {
    const iv = getInterview(app, c.params.id);
    const since = isoDate(c.query.get("since") ?? undefined, "取得の起点");
    const messages = store
      .notesOf(iv.id)
      .filter((n) => n.kind === "room" && (!since || n.createdAt > since))
      .map((n) => ({ ...n, userName: store.userName(n.userId) }));
    return { messages };
  });

  r.delete("/api/interviews/:id/notes/:noteId", "user", async (c) => {
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const notes = store.notesOf(iv.id);
      const target = notes.find((n) => n.id === c.params.noteId);
      if (!target) throw new HttpError(404, "メモが見つかりません");
      if (target.userId !== c.user!.id && c.user!.role !== "admin") {
        throw new HttpError(403, "自分のメモだけ削除できます");
      }
      await store.saveNotes(iv.id, notes.filter((n) => n.id !== target.id));
      return { notes: notesView(app, iv, c.user!) };
    });
  });

  // ---------------------------------------------------------------- 判定
  r.put("/api/interviews/:id/decision", "admin", async (c) => {
    const body = obj(await readJson(c));
    const result = oneOf(body.result, "判定", VOTES) as Vote;
    const reason = str(body.reason, "判定の理由", { max: 4000, optional: true, multiline: true });
    const decision: Decision = {
      result,
      reason,
      decidedBy: c.user!.id,
      decidedByName: c.user!.name,
      decidedAt: new Date().toISOString(),
    };
    const detail = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      iv.decision = decision;
      await store.saveInterview(iv);
      await audit(app, c, "decision", iv.id, result);
      return buildDetail(app, iv, c.user!);
    });
    void notifyDecision(app, detail.interview, decision);
    return detail;
  });

  r.delete("/api/interviews/:id/decision", "admin", async (c) => {
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (!iv.decision) throw new HttpError(409, "判定は確定していません");
      iv.decision = null;
      await store.saveInterview(iv);
      await audit(app, c, "decision_cancel", iv.id);
      return buildDetail(app, iv, c.user!);
    });
  });
}
