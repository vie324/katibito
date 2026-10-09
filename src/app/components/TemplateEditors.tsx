// 評価シートの部品: 質問(時間の目安つき)と評価項目(重みつき)の編集。
// 面接の登録画面と設定画面(評価シート)で使う。

import type { Criterion, QuestionPlan } from "../../shared/types";

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function totalMinutes(questions: QuestionPlan[]): number {
  return questions.reduce((s, q) => s + (q.minutes ?? 0), 0);
}

export function QuestionPlanEditor({
  value,
  onChange,
  max = 30,
}: {
  value: QuestionPlan[];
  onChange: (v: QuestionPlan[]) => void;
  max?: number;
}) {
  const set = (i: number, patch: Partial<QuestionPlan>) => onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const total = totalMinutes(value);
  return (
    <div className="plan-editor">
      {value.map((q, i) => (
        <div key={i} className="plan-row">
          <span className="num muted plan-no">Q{i + 1}</span>
          <input
            className="grow"
            value={q.text}
            maxLength={100}
            placeholder="質問"
            aria-label={`質問${i + 1}`}
            onChange={(e) => set(i, { text: e.target.value })}
          />
          <input
            className="minutes"
            type="number"
            min={1}
            max={120}
            value={q.minutes ?? ""}
            placeholder="分"
            aria-label={`質問${i + 1}の時間(分)`}
            onChange={(e) => set(i, { minutes: e.target.value === "" ? null : Math.max(1, Math.min(120, Math.round(Number(e.target.value)))) })}
          />
          <span className="muted small">分</span>
          <button type="button" className="quiet small" onClick={() => onChange(move(value, i, -1))} aria-label="上へ">
            ↑
          </button>
          <button type="button" className="quiet small" onClick={() => onChange(move(value, i, 1))} aria-label="下へ">
            ↓
          </button>
          <button type="button" className="quiet small danger-text" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            削除
          </button>
        </div>
      ))}
      <div className="row-actions left">
        <button type="button" disabled={value.length >= max} onClick={() => onChange([...value, { text: "", minutes: null }])}>
          質問を追加
        </button>
        {total > 0 && <span className="muted small">時間の目安の合計 {total}分</span>}
      </div>
    </div>
  );
}

export function CriteriaEditor({ value, onChange }: { value: Criterion[]; onChange: (v: Criterion[]) => void }) {
  const set = (id: string, patch: Partial<Criterion>) => onChange(value.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const wsum = value.reduce((s, c) => s + (c.weight || 1), 0);
  return (
    <div className="plan-editor">
      {value.map((c, i) => (
        <div key={c.id} className="plan-row criterion-edit">
          <input value={c.label} onChange={(e) => set(c.id, { label: e.target.value })} placeholder="項目名" maxLength={30} aria-label={`評価項目${i + 1}の名前`} />
          <input
            value={c.description}
            onChange={(e) => set(c.id, { description: e.target.value })}
            placeholder="説明(評価の観点)"
            maxLength={200}
            className="grow"
            aria-label={`評価項目${i + 1}の説明`}
          />
          <label className="weight">
            <span className="muted small">重み</span>
            <select value={c.weight} onChange={(e) => set(c.id, { weight: Number(e.target.value) })} aria-label={`評価項目${i + 1}の重み`}>
              {[1, 2, 3, 4, 5].map((w) => (
                <option key={w} value={w}>
                  ×{w}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small num weight-share">{wsum > 0 ? `${Math.round(((c.weight || 1) / wsum) * 100)}%` : ""}</span>
          <button type="button" className="quiet small" onClick={() => onChange(move(value, i, -1))} aria-label="上へ">
            ↑
          </button>
          <button type="button" className="quiet small" onClick={() => onChange(move(value, i, 1))} aria-label="下へ">
            ↓
          </button>
          <button type="button" className="quiet small danger-text" disabled={value.length <= 1} onClick={() => onChange(value.filter((x) => x.id !== c.id))}>
            削除
          </button>
        </div>
      ))}
      <div className="row-actions left">
        <button
          type="button"
          disabled={value.length >= 15}
          onClick={() => onChange([...value, { id: `c${Date.now().toString(36)}`, label: "", description: "", weight: 1 }])}
        >
          項目を追加
        </button>
        <span className="muted small">合計点は「評価 × 重み」の平均(1〜5点)です。右の % は合計点に占める割合です</span>
      </div>
    </div>
  );
}
