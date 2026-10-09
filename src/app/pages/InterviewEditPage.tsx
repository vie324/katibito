// 面接の登録・編集。

import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, type InterviewInput } from "../api";
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
  scheduledAt: string;
  location: string;
  interviewerIds: string[];
  questions: string;
};

function ageUnder18(age: string): boolean {
  const n = Number(age);
  return age !== "" && Number.isFinite(n) && n < 18;
}

export function InterviewEditPage({ id }: { id?: string }) {
  const { users, settings, user } = useSession();
  const { navigate } = useRouter();
  const [form, setForm] = useState<Form | null>(id ? null : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (id) {
      api
        .interview(id)
        .then((d) => {
          const iv = d.interview;
          setForm({
            displayName: iv.candidate.displayName,
            kana: iv.candidate.kana,
            age: iv.candidate.age === null ? "" : String(iv.candidate.age),
            minor: iv.candidate.minor,
            note: iv.candidate.note,
            scheduledAt: toLocalInput(iv.scheduledAt),
            location: iv.location,
            interviewerIds: iv.interviewerIds,
            questions: iv.questions.join("\n"),
          });
        })
        .catch((e) => setLoadError(errorMessage(e)));
    } else if (settings) {
      setForm(
        (prev) =>
          prev ?? {
            displayName: "",
            kana: "",
            age: "",
            minor: false,
            note: "",
            scheduledAt: "",
            location: "",
            interviewerIds: user && user.role === "interviewer" ? [user.id] : [],
            questions: settings.defaultQuestions.join("\n"),
          },
      );
    }
  }, [id, settings, user]);

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!form) return <Loading />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const activeUsers = users.filter((u) => !u.disabled || form.interviewerIds.includes(u.id));

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
      scheduledAt: fromLocalInput(form.scheduledAt),
      location: form.location,
      interviewerIds: form.interviewerIds,
      questions: form.questions
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const res = await run(() => (id ? api.updateInterview(id, body) : api.createInterview(body)));
    if (res) navigate(`/interviews/${res.interview.id}`, { replace: !id });
  };

  return (
    <div className="page narrow">
      <h2>{id ? "面接の編集" : "面接の登録"}</h2>
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
          <Field label="面接日時">
            <input type="datetime-local" value={form.scheduledAt} onChange={(e) => set("scheduledAt", e.target.value)} />
          </Field>
          <Field label="場所">
            <input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={100} />
          </Field>
        </div>
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
        <Field label="質問リスト" hint="1行に1問。録画中に「いまこの質問」と記録するボタンになり、質問ごとの集計に使います">
          <textarea value={form.questions} onChange={(e) => set("questions", e.target.value)} rows={6} />
        </Field>

        {error && <Notice kind="error">{error}</Notice>}
        <div className="row-actions">
          <button type="button" className="quiet" onClick={() => navigate(id ? `/interviews/${id}` : "/")}>
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
