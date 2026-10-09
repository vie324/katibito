// 設定(管理者): 基本 / 評価項目 / 同意文 / 保存期間 / ユーザー / 操作ログ / データ出力。

import { useEffect, useState } from "react";
import { renderConsentText } from "../../shared/consent";
import { DEFAULT_CONSENT_BODY, DEFAULT_CONSENT_TITLE, RECORDING_PRESETS } from "../../shared/defaults";
import type { AuditEntry, Criterion, Settings, UserPublic } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { Link } from "../router";
import { useSession } from "../session";
import { Field, Loading, Modal, Notice, useAction, useToast } from "../ui";

type Tab = "basic" | "criteria" | "consent" | "retention" | "users" | "audit" | "export";

const TABS: { key: Tab; label: string }[] = [
  { key: "basic", label: "基本" },
  { key: "criteria", label: "評価項目・質問" },
  { key: "consent", label: "同意文" },
  { key: "retention", label: "保存期間" },
  { key: "users", label: "ユーザー" },
  { key: "audit", label: "操作ログ" },
  { key: "export", label: "データ出力" },
];

export default function SettingsPage() {
  const { settings, reloadSettings, refresh } = useSession();
  const [tab, setTab] = useState<Tab>("basic");
  const [draft, setDraft] = useState<Settings | null>(null);
  const toast = useToast();
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  if (!draft) return <Loading />;

  const save = async () => {
    const res = await run(() => api.saveSettings(draft));
    if (res) {
      await reloadSettings();
      await refresh();
      toast("設定を保存しました");
    }
  };
  const settingsTab = tab === "basic" || tab === "criteria" || tab === "consent" || tab === "retention";

  return (
    <div className="page">
      <h2>設定</h2>
      <div className="tabs big-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "basic" && <BasicTab draft={draft} setDraft={setDraft} />}
      {tab === "criteria" && <CriteriaTab draft={draft} setDraft={setDraft} />}
      {tab === "consent" && <ConsentTab draft={draft} setDraft={setDraft} />}
      {tab === "retention" && <RetentionTab draft={draft} setDraft={setDraft} />}
      {tab === "users" && <UsersTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "export" && <ExportTab />}

      {settingsTab && (
        <div className="save-bar">
          {error && <Notice kind="error">{error}</Notice>}
          <span className="spacer" />
          <button className="quiet" onClick={() => settings && setDraft(structuredClone(settings))}>
            変更を戻す
          </button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            設定を保存
          </button>
        </div>
      )}
    </div>
  );
}

type TabProps = { draft: Settings; setDraft: (s: Settings) => void };

function BasicTab({ draft, setDraft }: TabProps) {
  return (
    <div className="panel pad form">
      <Field label="団体名" hint="同意文の {団体名} と画面上部に表示されます">
        <input value={draft.orgName} onChange={(e) => setDraft({ ...draft, orgName: e.target.value })} maxLength={80} />
      </Field>
      <Field label="お問い合わせ・同意の取り消しの連絡先" hint="同意文の {連絡先} に入ります(電話番号やメールアドレス)">
        <input value={draft.contact} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} maxLength={200} />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.blindEvaluation}
          onChange={(e) => setDraft({ ...draft, blindEvaluation: e.target.checked })}
        />
        <span>
          自分の評価を提出するまで、ほかの評価者の評価とメモを表示しない(おすすめ)
          <span className="muted small">— 先に見た評価に引っぱられるのを防ぎます</span>
        </span>
      </label>
      <Field label="録画の画質" hint="面接1時間あたりのデータ量の目安です。回線が細い会場では「軽量」を選んでください">
        <select
          value={draft.recording.videoBitsPerSecond}
          onChange={(e) => {
            const p = RECORDING_PRESETS.find((x) => x.videoBitsPerSecond === Number(e.target.value));
            if (p) setDraft({ ...draft, recording: { videoBitsPerSecond: p.videoBitsPerSecond, width: p.width, height: p.height } });
          }}
        >
          {RECORDING_PRESETS.map((p) => (
            <option key={p.videoBitsPerSecond} value={p.videoBitsPerSecond}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="通知先(Incoming Webhook の URL)"
        hint="Slack・Google Chat の Incoming Webhook に、録画の共有・評価の提出・判定の確定を通知します。通知には候補者の表示名が含まれます。空欄なら通知しません"
      >
        <input
          value={draft.webhookUrl ?? ""}
          onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value || null })}
          placeholder="https://hooks.slack.com/services/..."
        />
      </Field>
    </div>
  );
}

function CriteriaTab({ draft, setDraft }: TabProps) {
  const setCriteria = (criteria: Criterion[]) => setDraft({ ...draft, criteria });
  const move = (i: number, d: -1 | 1) => {
    const list = [...draft.criteria];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setCriteria(list);
  };
  return (
    <div className="panel pad form">
      <h3>評価項目</h3>
      <p className="muted small">面接官が1〜5で評価する項目です。項目を削除しても、過去の評価に残っている値は消えません(表示されなくなります)。</p>
      {draft.criteria.map((c, i) => (
        <div key={c.id} className="criterion-edit">
          <input
            value={c.label}
            onChange={(e) => setCriteria(draft.criteria.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)))}
            placeholder="項目名"
            maxLength={30}
          />
          <input
            value={c.description}
            onChange={(e) => setCriteria(draft.criteria.map((x) => (x.id === c.id ? { ...x, description: e.target.value } : x)))}
            placeholder="説明(評価の観点)"
            maxLength={200}
            className="grow"
          />
          <button className="quiet small" onClick={() => move(i, -1)} aria-label="上へ">
            ↑
          </button>
          <button className="quiet small" onClick={() => move(i, 1)} aria-label="下へ">
            ↓
          </button>
          <button className="quiet small danger-text" onClick={() => setCriteria(draft.criteria.filter((x) => x.id !== c.id))}>
            削除
          </button>
        </div>
      ))}
      <div className="row-actions left">
        <button
          onClick={() => setCriteria([...draft.criteria, { id: `c${Date.now().toString(36)}`, label: "", description: "" }])}
          disabled={draft.criteria.length >= 15}
        >
          項目を追加
        </button>
      </div>

      <h3>評価の段階(1〜5の呼び方)</h3>
      <div className="rating-labels">
        {draft.ratingLabels.map((l, i) => (
          <label key={i} className="field">
            <span className="field-label num">{i + 1}</span>
            <input
              value={l}
              maxLength={12}
              onChange={(e) => setDraft({ ...draft, ratingLabels: draft.ratingLabels.map((x, j) => (j === i ? e.target.value : x)) })}
            />
          </label>
        ))}
      </div>

      <h3>質問リストの初期値</h3>
      <Field label="1行に1問" hint="面接を登録するときの初期値です。面接ごとに変更できます">
        <textarea
          rows={7}
          value={draft.defaultQuestions.join("\n")}
          onChange={(e) =>
            setDraft({
              ...draft,
              defaultQuestions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
            })
          }
        />
      </Field>
    </div>
  );
}

function ConsentTab({ draft, setDraft }: TabProps) {
  const rendered = renderConsentText(draft);
  return (
    <div className="consent-edit">
      <div className="panel pad form">
        <Field label="タイトル">
          <input value={draft.consent.title} onChange={(e) => setDraft({ ...draft, consent: { ...draft.consent, title: e.target.value } })} maxLength={100} />
        </Field>
        <Field label="本文" hint="{団体名} {保存日数} {連絡先} は自動で置き換わります。運用に合わせて書き換えてください">
          <textarea
            rows={24}
            value={draft.consent.body}
            onChange={(e) => setDraft({ ...draft, consent: { ...draft.consent, body: e.target.value } })}
          />
        </Field>
        <div className="row-actions left">
          <button
            className="quiet small"
            onClick={() => setDraft({ ...draft, consent: { title: DEFAULT_CONSENT_TITLE, body: DEFAULT_CONSENT_BODY } })}
          >
            初期の文面に戻す
          </button>
        </div>
        <Notice kind="info">
          同意を記録するときは、その時点の文面がそのまま保存されます。文面を変えても、過去の同意の記録は変わりません。
        </Notice>
      </div>
      <div className="panel pad">
        <div className="muted small">プレビュー(候補者に見せる画面)</div>
        <div className="consent-doc small-doc">
          <h2>{rendered.title}</h2>
          {rendered.body.split("\n").map((l, i) => (l.trim() === "" ? <br key={i} /> : <p key={i}>{l}</p>))}
        </div>
      </div>
    </div>
  );
}

function RetentionTab({ draft, setDraft }: TabProps) {
  const toast = useToast();
  const { busy, error, run } = useAction();
  return (
    <div className="panel pad form">
      <Field label="判定が確定してから録画を消すまでの日数" hint="同意文の {保存日数} に入ります。映像と顔の時系列データを削除し、表情の集計(数値)と評価は残します">
        <input
          type="number"
          min={1}
          max={3650}
          value={draft.retention.videoDaysAfterDecision}
          onChange={(e) => setDraft({ ...draft, retention: { ...draft.retention, videoDaysAfterDecision: Number(e.target.value) } })}
        />
      </Field>
      <Field label="判定が出ないまま録画を残しておく上限の日数" hint="判定を忘れたままの録画が残り続けないようにします">
        <input
          type="number"
          min={7}
          max={3650}
          value={draft.retention.videoDaysUndecided}
          onChange={(e) => setDraft({ ...draft, retention: { ...draft.retention, videoDaysUndecided: Number(e.target.value) } })}
        />
      </Field>
      <p className="muted small">削除は6時間ごとに自動で行います。保存した設定ですぐに実行する場合は下のボタンを押してください。</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="row-actions left">
        <button
          disabled={busy}
          onClick={async () => {
            const r = await run(() => api.runRetention());
            if (r) toast(`期限を過ぎた録画 ${r.purged}件、未完了のアップロード ${r.staleRemoved}件を削除しました`);
          }}
        >
          保存期間の処理をいま実行する
        </button>
      </div>
    </div>
  );
}

function UsersTab() {
  const { users, reloadUsers, user: me } = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserPublic | null>(null);

  return (
    <div className="panel">
      <div className="panel-title">
        ユーザー
        <span className="spacer" />
        <button className="primary small-btn" onClick={() => setAdding(true)}>
          ユーザーを追加
        </button>
      </div>
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              <th>氏名</th>
              <th>ログインID</th>
              <th>権限</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? "dimmed" : ""}>
                <td>{u.name}</td>
                <td className="num">{u.loginId}</td>
                <td>{u.role === "admin" ? "管理者" : "面接官"}</td>
                <td>{u.disabled ? "無効" : "有効"}</td>
                <td className="right">
                  <button className="quiet small" onClick={() => setEditing(u)}>
                    変更
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pad muted small">
        管理者は、設定・ユーザー管理・判定・削除ができます。面接官は、面接の登録・録画・評価ができます。
        退職した人は削除せず「無効」にしてください(過去の評価に名前が残ります)。
      </div>

      {adding && (
        <UserForm
          onClose={() => setAdding(false)}
          onSaved={async () => {
            await reloadUsers();
            setAdding(false);
            toast("ユーザーを追加しました。ログインIDと初期パスワードを本人に伝えてください");
          }}
        />
      )}
      {editing && (
        <UserForm
          user={editing}
          isSelf={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reloadUsers();
            setEditing(null);
            toast("ユーザーを更新しました");
          }}
        />
      )}
    </div>
  );
}

function UserForm({ user, isSelf, onClose, onSaved }: { user?: UserPublic; isSelf?: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(user?.name ?? "");
  const [loginId, setLoginId] = useState(user?.loginId ?? "");
  const [role, setRole] = useState<string>(user?.role ?? "interviewer");
  const [password, setPassword] = useState("");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const { busy, error, run } = useAction();

  const submit = async () => {
    const ok = await run(async () => {
      if (user) {
        const patch: Partial<{ name: string; role: string; disabled: boolean; password: string }> = {};
        if (name !== user.name) patch.name = name;
        if (role !== user.role) patch.role = role;
        if (disabled !== user.disabled) patch.disabled = disabled;
        if (password) patch.password = password;
        return api.updateUser(user.id, patch);
      }
      return api.createUser({ loginId, name, role, password });
    });
    if (ok) await onSaved();
  };

  return (
    <Modal title={user ? `${user.name} の変更` : "ユーザーを追加"} onClose={onClose}>
      <div className="form">
        <Field label="氏名" required>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        {!user && (
          <Field label="ログインID" required hint="半角英数字(本人がログインに使います)">
            <input value={loginId} onChange={(e) => setLoginId(e.target.value)} maxLength={64} autoComplete="off" />
          </Field>
        )}
        <Field label="権限">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="interviewer">面接官</option>
            <option value="admin">管理者</option>
          </select>
        </Field>
        <Field label={user ? "パスワードの再設定" : "初期パスワード"} required={!user} hint={user ? "変更する場合のみ入力(8文字以上)。この人のほかの端末のログインは解除されます" : "8文字以上。本人に伝え、ログイン後に変更してもらってください"}>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="text" autoComplete="off" />
        </Field>
        {user && !isSelf && (
          <label className="check">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            <span>このユーザーを無効にする(ログインできなくなります)</span>
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="row-actions">
          <button className="quiet" onClick={onClose}>
            キャンセル
          </button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  setup: "初期設定",
  login: "ログイン",
  login_failed: "ログイン失敗",
  password_change: "パスワード変更",
  user_create: "ユーザー追加",
  user_update: "ユーザー変更",
  settings_update: "設定変更",
  interview_create: "面接の登録",
  interview_update: "面接の編集",
  interview_view: "面接の閲覧",
  interview_delete: "面接の削除",
  consent_record: "同意の記録",
  consent_withdraw: "同意の取り消し",
  recording_start: "録画の開始",
  recording_complete: "録画の送信完了",
  recording_delete: "録画の削除",
  recording_abort: "録画の送信の取り消し",
  recording_reprocess: "録画の再処理",
  analysis_upload: "表情の計測の登録",
  video_view: "録画の再生",
  evaluation_save: "評価の下書き",
  evaluation_submit: "評価の提出",
  evaluation_revise: "提出後の評価の修正",
  decision: "判定",
  decision_cancel: "判定の取り消し",
  retention_purge: "保存期間による削除",
  retention_run: "保存期間の処理(手動)",
  export_csv: "CSV出力",
};

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .audit(500)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!entries) return <Loading />;
  return (
    <div className="panel">
      <div className="panel-title">操作ログ(新しい順・最大500件)</div>
      <div className="table-wrap">
        <table className="list audit">
          <thead>
            <tr>
              <th>日時</th>
              <th>ユーザー</th>
              <th>操作</th>
              <th>対象</th>
              <th>詳細</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td className="num nowrap">{formatDateTime(e.ts)}</td>
                <td>{e.userName ?? "—"}</td>
                <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                <td className="num small">{e.interviewId ? <Link to={`/interviews/${e.interviewId}`}>{e.interviewId.slice(0, 8)}</Link> : ""}</td>
                <td className="small">{e.detail ?? ""}</td>
                <td className="num small muted">{e.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExportTab() {
  return (
    <div className="panel pad">
      <p>面接の一覧(候補者・面接官・評価の集計・判定・表情の計測の主な数値)を CSV で出力します。Excel でそのまま開けます。</p>
      <p className="muted small">出力したファイルには個人情報が含まれます。取り扱いに注意してください(出力の記録は操作ログに残ります)。</p>
      <a className="button primary" href={api.exportCsvUrl} download>
        CSV をダウンロード
      </a>
    </div>
  );
}
