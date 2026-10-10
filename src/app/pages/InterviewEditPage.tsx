// 面接の登録・編集。?from=<面接ID> で「同じ候補者の次の面接」を登録する(候補者の情報を引き継ぐ)。

import { useEffect, useState, type FormEvent } from "react";
import type { QuestionPlan, Settings } from "../../shared/types";
import { api, errorMessage, type InterviewInput } from "../api";
import { QuestionPlanEditor } from "../components/TemplateEditors";
import { fromLocalInput, toLocalInput } from "../format";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Field, Loading, Notice, useAction } from "../ui";

type Form = {
  displayName: string;
  kana: string;
  age: string;
  minor: boolean;
  note: string;
  round: string;
  scheduledAt: string;
  location: string;
  interviewerIds: string[];
  templateId: string;
  questions: QuestionPlan[];
};

const ROUND_SUGGESTIONS = ["一次面接", "二次面接", "最終面接", "再面接"];

function ageUnder18(age: string): boolean {
  const n = Number(age);
  return age !== "" && Number.isFinite(n) && n < 18;
}

function templateQuestions(settings: Settings, templateId: string): QuestionPlan[] {
  const t = settings.templates.find((x) => x.id === templateId) ?? settings.templates[0];
  return t.questions.map((q) => ({ ...q }));
}

/** 前の面接の段階から、次の段階の候補を出す(一次 → 二次 → 最終) */
function nextRound(round: string): string {
  if (round.includes("一次")) return "二次面接";
  if (round.includes("二次")) return "最終面接";
  return "";
}

export function InterviewEditPage({ id }: { id?: string }) {
  const { users, settings, user } = useSession();
  const { navigate, search } = useRouter();
  const fromId = id ? null : search.get("from");
  const [form, setForm] = useState<Form | null>(null);
  const [hasEvaluations, setHasEvaluations] = useState(false);
  const [fromName, setFromName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!settings) return;
    if (id) {
      api
        .interview(id)
        .then((d) => {
          const iv = d.interview;
          setHasEvaluations(!!d.evaluations.mine || d.evaluations.othersSubmittedCount > 0);
          setForm({
            displayName: iv.candidate.displayName,
            kana: iv.candidate.kana,
            age: iv.candidate.age === null ? "" : String(iv.candidate.age),
            minor: iv.candidate.minor,
            note: iv.candidate.note,
            round: iv.round,
            scheduledAt: toLocalInput(iv.scheduledAt),
            location: iv.location,
            interviewerIds: iv.interviewerIds,
            templateId: iv.templateId ?? settings.defaultTemplateId,
            questions: iv.questions.map((text, i) => ({ text, minutes: iv.questionMinutes[i] ?? null })),
          });
        })
        .catch((e) => setLoadError(errorMessage(e)));
      return;
    }
    const blank: Form = {
      displayName: "",
      kana: "",
      age: "",
      minor: false,
      note: "",
      round: "",
      scheduledAt: "",
      location: "",
      interviewerIds: user && user.role === "interviewer" ? [user.id] : [],
      templateId: settings.defaultTemplateId,
      questions: templateQuestions(settings, settings.defaultTemplateId),
    };
    if (!fromId) {
      setForm((prev) => prev ?? blank);
      return;
    }
    // 次の面接: 候補者・面接官・評価シートを前の面接から引き継ぐ
    api
      .interview(fromId)
      .then((d) => {
        const iv = d.interview;
        const templateId = settings.templates.some((t) => t.id === iv.templateId) ? iv.templateId! : settings.defaultTemplateId;
        setFromName(`${iv.candidate.displayName}${iv.round ? `(${iv.round})` : ""}`);
        setForm({
          ...blank,
          displayName: iv.candidate.displayName,
          kana: iv.candidate.kana,
          age: iv.candidate.age === null ? "" : String(iv.candidate.age),
          minor: iv.candidate.minor,
          note: iv.candidate.note,
          round: nextRound(iv.round),
          location: iv.location,
          interviewerIds: iv.interviewerIds,
          templateId,
          questions: templateQuestions(settings, templateId),
        });
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [id, fromId, settings, user]);

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!form || !settings) return <Loading />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const activeUsers = users.filter((u) => !u.disabled || form.interviewerIds.includes(u.id));
  const templateLocked = !!id && hasEvaluations;

  const changeTemplate = (templateId: string) => {
    // 新しい面接では、評価シートの質問に入れ替える(編集中の面接は質問を残す)
    setForm({ ...form, templateId, questions: id ? form.questions : templateQuestions(settings, templateId) });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const age = form.age.trim() === "" ? null : Number(form.age);
    const body: InterviewInput = {
      candidate: {
        displayName: form.displayName,
        kana: form.kana,
        age: age !== null && Number.isFinite(age) ? Math.round(age) : null,
        minor: form.minor,
        note: form.note,
      },
      round: form.round,
      scheduledAt: fromLocalInput(form.scheduledAt),
      location: form.location,
      interviewerIds: form.interviewerIds,
      questions: form.questions.map((q) => ({ text: q.text.trim(), minutes: q.minutes })).filter((q) => q.text),
      ...(templateLocked ? {} : { templateId: form.templateId }),
      ...(fromId ? { fromInterviewId: fromId } : {}),
    };
    const res = await run(() => (id ? api.updateInterview(id, body) : api.createInterview(body)));
    if (res) navigate(`/interviews/${res.interview.id}`, { replace: !id });
  };

  return (
    <div className="page narrow">
      <h2>{id ? "面接の編集" : fromId ? "次の面接の登録" : "面接の登録"}</h2>
      {fromName && <Notice kind="info">{fromName} と同じ候補者の面接として登録します。候補者の詳細画面で、面接をまとめて見られます。</Notice>}
      <form className="panel pad form" onSubmit={submit}>
        <h3>候補者</h3>
        <Field label="表示名" required hint="画面と通知に表示されます。イニシャルや受付番号でも構いません">
          <input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} required maxLength={60} />
        </Field>
        <div className="grid2">
          <Field label="ふりがな">
            <input value={form.kana} onChange={(e) => set("kana", e.target.value)} maxLength={60} />
          </Field>
          <Field label="年齢">
            <input
              type="number"
              min={0}
              max={120}
              value={form.age}
              onChange={(e) => {
                const v = e.target.value;
                const n = Number(v);
                setForm({ ...form, age: v, minor: v !== "" && Number.isFinite(n) ? n < 18 : form.minor });
              }}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.minor || ageUnder18(form.age)}
            disabled={ageUnder18(form.age)}
            onChange={(e) => set("minor", e.target.checked)}
          />
          <span>未成年(録画には保護者の同意が必要です){ageUnder18(form.age) ? "。18歳未満のため常に未成年として扱います" : ""}</span>
        </label>
        <Field label="メモ" hint="面接官への申し送りなど">
          <textarea value={form.note} onChange={(e) => set("note", e.target.value)} rows={2} maxLength={1000} />
        </Field>

        <h3>面接</h3>
        <div className="grid2">
          <Field label="面接の段階" hint="一次・二次など。空欄でも構いません">
            <input value={form.round} onChange={(e) => set("round", e.target.value)} maxLength={20} list="round-suggestions" />
          </Field>
          <Field label="面接日時">
            <input type="datetime-local" value={form.scheduledAt} onChange={(e) => set("scheduledAt", e.target.value)} />
          </Field>
        </div>
        <datalist id="round-suggestions">
          {ROUND_SUGGESTIONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <Field label="場所">
          <input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={100} />
        </Field>
        <Field label="面接官" hint="ここで選んだ人全員の評価がそろうと「判定待ち」になります">
          <div className="checks">
            {activeUsers.map((u) => (
              <label key={u.id} className="check">
                <input
                  type="checkbox"
                  checked={form.interviewerIds.includes(u.id)}
                  onChange={(e) =>
                    set(
                      "interviewerIds",
                      e.target.checked ? [...form.interviewerIds, u.id] : form.interviewerIds.filter((x) => x !== u.id),
                    )
                  }
                />
                <span>
                  {u.name}
                  {u.role === "admin" && <span className="muted small">(管理者)</span>}
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field
          label="評価シート"
          hint={templateLocked ? "評価が入力済みのため変更できません" : "評価項目と質問の組み合わせです。管理者が「設定 > 評価シート」で用意します"}
        >
          <select value={form.templateId} disabled={templateLocked} onChange={(e) => changeTemplate(e.target.value)}>
            {settings.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}(評価項目 {t.criteria.length}・質問 {t.questions.length})
              </option>
            ))}
          </select>
        </Field>
        <div className="field">
          <span className="field-label">質問と時間の目安</span>
          <QuestionPlanEditor value={form.questions} onChange={(questions) => set("questions", questions)} />
          <span className="field-hint">録画中に「いまこの質問」と記録するボタンになり、質問ごとの集計と時間の目安の表示に使います</span>
        </div>

        {error && <Notice kind="error">{error}</Notice>}
        <div className="row-actions">
          <button type="button" className="quiet" onClick={() => navigate(id ? `/interviews/${id}` : fromId ? `/interviews/${fromId}` : "/")}>
            キャンセル
          </button>
          <button className="primary" disabled={busy}>
            {id ? "保存する" : "登録する"}
          </button>
        </div>
      </form>
    </div>
  );
}
