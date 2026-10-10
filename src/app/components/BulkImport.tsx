// 面接のまとめて登録(管理者)。表計算ソフトの一覧(CSV・タブ区切り)を読み込み、1行ずつ確かめてから登録する。
// 1行でも誤りがあれば登録しない(直してから読み込み直す)。

import { useMemo, useState } from "react";
import type { InterviewTemplate, UserPublic } from "../../shared/types";
import { api, errorMessage, type InterviewInput } from "../api";
import { csvCell, decodeText, parseJstDateTime, parseTable } from "../csv";
import { saveFile } from "../download";
import { formatDateTime } from "../format";
import { useSession } from "../session";
import { Modal, Notice } from "../ui";

type ColumnKey = "displayName" | "kana" | "age" | "round" | "scheduledAt" | "location" | "interviewers" | "template" | "note";

const COLUMNS: { key: ColumnKey; label: string; aliases: string[] }[] = [
  { key: "displayName", label: "表示名", aliases: ["表示名", "氏名", "名前", "候補者"] },
  { key: "kana", label: "ふりがな", aliases: ["ふりがな", "よみがな", "フリガナ"] },
  { key: "age", label: "年齢", aliases: ["年齢"] },
  { key: "round", label: "面接の段階", aliases: ["面接の段階", "段階"] },
  { key: "scheduledAt", label: "面接日時", aliases: ["面接日時", "日時"] },
  { key: "location", label: "場所", aliases: ["場所"] },
  { key: "interviewers", label: "面接官", aliases: ["面接官"] },
  { key: "template", label: "評価シート", aliases: ["評価シート"] },
  { key: "note", label: "メモ", aliases: ["メモ", "備考"] },
];

type BulkRow = Omit<InterviewInput, "questions" | "fromInterviewId">;
type Parsed = { line: number; cells: Partial<Record<ColumnKey, string>>; body: BulkRow; errors: string[]; interviewerNames: string[] };

function parseRows(table: string[][], users: UserPublic[], templates: InterviewTemplate[]): { rows: Parsed[]; problem: string | null } {
  if (table.length < 2) return { rows: [], problem: "見出しの行と、1行以上のデータが必要です" };
  const header = table[0].map((h) => h.trim());
  const index = new Map<ColumnKey, number>();
  for (const c of COLUMNS) {
    const i = header.findIndex((h) => c.aliases.includes(h));
    if (i >= 0) index.set(c.key, i);
  }
  if (!index.has("displayName")) return { rows: [], problem: "「表示名」の列が見つかりません(1行目に見出しを入れてください)" };
  const active = users.filter((u) => !u.disabled);
  const rows = table.slice(1).map((r, n): Parsed => {
    const cells: Partial<Record<ColumnKey, string>> = {};
    for (const [k, i] of index) cells[k] = (r[i] ?? "").trim();
    const errors: string[] = [];
    const displayName = cells.displayName ?? "";
    if (!displayName) errors.push("表示名がありません");
    if (displayName.length > 60) errors.push("表示名は60文字までです");
    let age: number | null = null;
    if (cells.age) {
      const a = Number(cells.age.replace(/歳$/, ""));
      if (!Number.isInteger(a) || a < 0 || a > 120) errors.push("年齢は0〜120の整数にしてください");
      else age = a;
    }
    let scheduledAt: string | null = null;
    if (cells.scheduledAt) {
      scheduledAt = parseJstDateTime(cells.scheduledAt);
      if (!scheduledAt) errors.push("面接日時は「2026/10/12 10:00」の形で入れてください");
    }
    const interviewerIds: string[] = [];
    const interviewerNames: string[] = [];
    for (const token of (cells.interviewers ?? "").split(/[/／・、,，;]/).map((x) => x.trim()).filter(Boolean)) {
      const u = active.find((x) => x.loginId === token || x.name === token);
      if (!u) errors.push(`面接官「${token}」が見つかりません(ログインIDか氏名)`);
      else if (!interviewerIds.includes(u.id)) {
        interviewerIds.push(u.id);
        interviewerNames.push(u.name);
      }
    }
    let templateId: string | undefined;
    if (cells.template) {
      const t = templates.find((x) => x.name === cells.template);
      if (!t) errors.push(`評価シート「${cells.template}」が見つかりません`);
      else templateId = t.id;
    }
    if ((cells.round ?? "").length > 20) errors.push("面接の段階は20文字までです");
    if ((cells.location ?? "").length > 100) errors.push("場所は100文字までです");
    if ((cells.kana ?? "").length > 60) errors.push("ふりがなは60文字までです");
    return {
      line: n + 2,
      cells,
      errors,
      interviewerNames,
      body: {
        candidate: { displayName, kana: cells.kana ?? "", age, minor: age !== null && age < 18, note: (cells.note ?? "").slice(0, 1000) },
        round: cells.round ?? "",
        scheduledAt,
        location: cells.location ?? "",
        interviewerIds,
        templateId,
      },
    };
  });
  if (rows.length > 300) return { rows: [], problem: "一度に登録できるのは300件までです" };
  return { rows, problem: null };
}

export function BulkImport({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const { users, settings } = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = settings?.templates ?? [];

  const parsed = useMemo(() => (text.trim() ? parseRows(parseTable(text), users, templates) : null), [text, users, templates]);
  const bad = parsed?.rows.filter((r) => r.errors.length > 0).length ?? 0;
  const canSubmit = !!parsed && !parsed.problem && parsed.rows.length > 0 && bad === 0 && !busy;

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setText(decodeText(await f.arrayBuffer()));
  };

  const template = () => {
    const header = COLUMNS.map((c) => c.label);
    const example = ["山田 太郎", "やまだ たろう", "12", "一次面接", "2026/10/20 10:00", "本校 2F", users.filter((u) => !u.disabled).slice(0, 2).map((u) => u.loginId).join("/"), templates[0]?.name ?? "", ""];
    const csv = "﻿" + [header, example].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    saveFile(csv, "面接の一括登録_ひな形.csv", "text/csv;charset=utf-8");
  };

  const submit = async () => {
    if (!parsed || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.bulkCreateInterviews(parsed.rows.map((x) => x.body));
      onDone(r.created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="面接をまとめて登録" onClose={onClose} wide>
      <div className="form bulk-import">
        <p className="small">
          表計算ソフト(Excel など)の一覧から、面接をまとめて登録します。1行目に見出し(
          {COLUMNS.map((c) => c.label).join("・")})を入れ、2行目から1件ずつ書きます。「表示名」のほかは空欄でもかまいません。
          面接官はログインIDか氏名を「/」で区切って、面接日時は「2026/10/20 10:00」の形で入れます。
        </p>
        <div className="row-actions left">
          <label className="button">
            CSV ファイルを選ぶ
            <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
          </label>
          <button type="button" className="quiet" onClick={template}>
            ひな形をダウンロード
          </button>
        </div>
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="または、表計算ソフトで範囲を選んでコピーし、ここに貼り付けます"
          aria-label="登録する一覧"
        />
        {parsed?.problem && <Notice kind="error">{parsed.problem}</Notice>}
        {parsed && !parsed.problem && parsed.rows.length > 0 && (
          <>
            <div className="small">
              {parsed.rows.length}件 {bad > 0 ? <span className="warn-text">・ {bad}件に誤りがあります(直してから読み込み直してください)</span> : <span className="ok-text">・ 登録できます</span>}
            </div>
            <div className="table-wrap bulk-preview">
              <table className="list">
                <thead>
                  <tr>
                    <th>行</th>
                    <th>表示名</th>
                    <th>年齢</th>
                    <th>段階</th>
                    <th>面接日時</th>
                    <th>面接官</th>
                    <th>評価シート</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((r) => (
                    <tr key={r.line} className={r.errors.length > 0 ? "bulk-bad" : ""}>
                      <td className="num">{r.line}</td>
                      <td>
                        {r.body.candidate.displayName}
                        {r.body.candidate.kana && <div className="muted small">{r.body.candidate.kana}</div>}
                      </td>
                      <td className="num">{r.body.candidate.age ?? ""}</td>
                      <td>{r.body.round}</td>
                      <td className="num nowrap">{r.body.scheduledAt ? formatDateTime(r.body.scheduledAt) : ""}</td>
                      <td className="small">{r.interviewerNames.join("・")}</td>
                      <td className="small">{r.cells.template || <span className="muted">既定</span>}</td>
                      <td className="small warn-text">{r.errors.join(" / ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="row-actions">
          <button type="button" className="quiet" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "登録中…" : `${parsed?.rows.length ?? 0}件を登録する`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
