// 設定(管理者): 基本 / 評価項目 / 同意文 / 保存期間 / ユーザー / 操作ログ / データ出力。

import { useEffect, useState } from "react";
import { renderConsentText } from "../../shared/consent";
import { DEFAULT_CONSENT_BODY, DEFAULT_CONSENT_TITLE, RECORDING_PRESETS } from "../../shared/defaults";
import { DEFAULT_NOTICES, NOTICE_PLACEHOLDERS } from "../../shared/notice";
import { VOTE_LABEL } from "../../shared/status";
import type { AuditEntry, InterviewTemplate, NoticeTemplate, Settings, TranscriptionStatus, UserAccount, Vote } from "../../shared/types";
import { api, errorMessage } from "../api";
import { CriteriaEditor, QuestionPlanEditor } from "../components/TemplateEditors";
import { formatDateTime } from "../format";
import { Link } from "../router";
import { useSession } from "../session";
import { Field, Loading, Modal, Notice, useAction, useToast } from "../ui";

type Tab = "basic" | "templates" | "features" | "consent" | "notices" | "retention" | "users" | "audit" | "export";

const TABS: { key: Tab; label: string }[] = [
  { key: "basic", label: "基本" },
  { key: "templates", label: "評価シート" },
  { key: "features", label: "機能" },
  { key: "consent", label: "同意文" },
  { key: "notices", label: "通知書" },
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
  const settingsTab = ["basic", "templates", "features", "consent", "notices", "retention"].includes(tab);

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
      {tab === "templates" && <TemplatesTab draft={draft} setDraft={setDraft} />}
      {tab === "features" && <FeaturesTab draft={draft} setDraft={setDraft} />}
      {tab === "consent" && <ConsentTab draft={draft} setDraft={setDraft} />}
      {tab === "notices" && <NoticesTab draft={draft} setDraft={setDraft} />}
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
      <Field label="面接官が見られる面接" hint="管理者はすべての面接を見られます">
        <select
          value={draft.access.interviewerScope}
          onChange={(e) => setDraft({ ...draft, access: { ...draft.access, interviewerScope: e.target.value as Settings["access"]["interviewerScope"] } })}
        >
          <option value="all">すべての面接</option>
          <option value="assigned">面接官に選ばれた面接と、自分が登録した面接だけ</option>
        </select>
      </Field>
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

function FeaturesTab({ draft, setDraft }: TabProps) {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .transcriptionStatus()
        .then((r) => alive && setStatus(r.status))
        .catch((e) => alive && setError(errorMessage(e)));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="panel pad form">
      <h3>文字起こし</h3>
      <p className="muted small">
        録画の音声を、サーバーの中で文字にします(whisper.cpp。外部のサービスには送りません)。録画の確認画面の「文字起こし」で、
        話した内容を読んだり、ことばで探したりできます。同意文にも、文字起こしをすることを書いておいてください。
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.transcription.enabled}
          onChange={(e) => setDraft({ ...draft, transcription: { enabled: e.target.checked } })}
        />
        <span>録画が届いたら、自動で文字起こしをする</span>
      </label>
      {error && <Notice kind="error">{error}</Notice>}
      {status && (
        <div className="feature-status">
          {status.available ? (
            <>
              <span className="ok-text">● このサーバーで使えます</span>
              <span className="muted small">
                モデル {status.model}
                {status.modelReady ? "(準備済み)" : status.downloading !== null ? `(取得中 ${Math.round(status.downloading * 100)}%)` : "(未取得: 最初の文字起こしのときに取得します)"}
              </span>
              {status.progress && (
                <span className="muted small">処理中 {Math.round(status.progress.fraction * 100)}%{status.queued > 0 ? ` ・ 順番待ち ${status.queued}件` : ""}</span>
              )}
              {!status.modelReady && status.downloading === null && (
                <button
                  className="quiet small"
                  onClick={async () => {
                    try {
                      setStatus((await api.prepareTranscription()).status);
                      toast("モデルの取得を始めました");
                    } catch (e) {
                      toast(errorMessage(e), "error");
                    }
                  }}
                >
                  いまモデルを取得する(約200MB)
                </button>
              )}
              {status.error && <span className="warn-text small">直近のエラー: {status.error}</span>}
            </>
          ) : (
            <span className="warn-text small">このサーバーでは使えません: {status.reason}</span>
          )}
        </div>
      )}

      <MailSection draft={draft} setDraft={setDraft} />

      <h3>映像の取り扱い</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.security.watermark}
          onChange={(e) => setDraft({ ...draft, security: { ...draft.security, watermark: e.target.checked } })}
        />
        <span>
          再生中の映像に、見ている人の名前と日付を薄く表示する(おすすめ)
          <span className="muted small">— 画面の撮影や持ち出しを防ぐため</span>
        </span>
      </label>

      <h3>ログイン</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.security.requireTotpForAdmins}
          onChange={(e) => setDraft({ ...draft, security: { ...draft.security, requireTotpForAdmins: e.target.checked } })}
        />
        <span>
          管理者に2段階認証を必須にする(おすすめ)
          <span className="muted small">— 管理者は録画・評価・設定のすべてに触れられるため。オンにする前に、自分の2段階認証を「アカウント」で設定してください</span>
        </span>
      </label>
    </div>
  );
}

function MailSection({ draft, setDraft }: TabProps) {
  const [status, setStatus] = useState<{ enabled: boolean; host: string | null; from: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const r = draft.reminders;
  const set = (patch: Partial<Settings["reminders"]>) => setDraft({ ...draft, reminders: { ...r, ...patch } });

  useEffect(() => {
    api
      .mailStatus()
      .then((x) => setStatus(x.status))
      .catch(() => undefined);
  }, []);

  const test = async () => {
    setSending(true);
    try {
      const res = await api.sendTestMail();
      toast(`${res.to} にテストメールを送りました`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <h3>メールのお知らせ</h3>
      <p className="muted small">
        録画の共有(評価のお願い)・ライブの開始・評価がそろったとき・判定の確定・オンラインの同意をメールで知らせます。
        受け取る内容は、各自が「アカウント」で選びます。メールには候補者の表示名・日時・リンクだけが載ります。
      </p>
      {status && (
        <div className="feature-status">
          {status.enabled ? (
            <>
              <span className="ok-text">● 送信できます</span>
              <span className="muted small">
                {status.host} ・ 差出人 {status.from}
              </span>
              <button className="quiet small" disabled={sending} onClick={() => void test()}>
                {sending ? "送信中…" : "自分にテストメールを送る"}
              </button>
            </>
          ) : (
            <span className="warn-text small">
              このサーバーではメールを送りません(環境変数 SMTP_HOST・MAIL_FROM などを設定してください。運用ガイド参照)
            </span>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>評価の催促と、前日のお知らせを送る</span>
      </label>
      <div className="grid2">
        <Field label="評価の催促までの時間" hint="録画が共有されてから、この時間たっても未提出なら催促します(24時間おき・最大3回)">
          <select value={r.evaluationAfterHours} disabled={!r.enabled} onChange={(e) => set({ evaluationAfterHours: Number(e.target.value) })}>
            {[6, 12, 24, 48, 72].map((h) => (
              <option key={h} value={h}>
                {h}時間後
              </option>
            ))}
          </select>
        </Field>
        <Field label="前日のお知らせの時刻" hint="面接の前日のこの時刻以降に、担当の面接官へ送ります">
          <select value={r.dayBeforeHour} disabled={!r.enabled} onChange={(e) => set({ dayBeforeHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h}時
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

function TemplatesTab({ draft, setDraft }: TabProps) {
  const [selected, setSelected] = useState(draft.defaultTemplateId);
  const t = draft.templates.find((x) => x.id === selected) ?? draft.templates[0];
  const setTemplate = (patch: Partial<InterviewTemplate>) =>
    setDraft({ ...draft, templates: draft.templates.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) });

  const add = (base?: InterviewTemplate) => {
    const id = `t${Date.now().toString(36)}`;
    const names = new Set(draft.templates.map((x) => x.name));
    let name = base ? `${base.name}のコピー` : "新しい評価シート";
    for (let n = 2; names.has(name); n++) name = `${base ? `${base.name}のコピー` : "新しい評価シート"}${n}`;
    const next: InterviewTemplate = base
      ? { ...structuredClone(base), id, name }
      : { id, name, criteria: [{ id: `c${Date.now().toString(36)}`, label: "", description: "", weight: 1 }], questions: [], passLine: null };
    setDraft({ ...draft, templates: [...draft.templates, next] });
    setSelected(id);
  };
  const remove = () => {
    if (draft.templates.length <= 1 || t.id === draft.defaultTemplateId) return;
    if (!window.confirm(`評価シート「${t.name}」を削除しますか?(この評価シートで登録済みの面接には影響しません)`)) return;
    const templates = draft.templates.filter((x) => x.id !== t.id);
    setDraft({ ...draft, templates });
    setSelected(draft.defaultTemplateId);
  };

  return (
    <div className="panel pad form">
      <p className="muted small">
        評価シートは「評価項目(重みつき)」と「質問(時間の目安つき)」の組み合わせです。面接の種類ごとに用意し、面接の登録時に選びます。
        登録済みの面接は登録時の内容を使うため、ここで変更しても過去の評価は変わりません。
      </p>
      <div className="template-bar">
        <select value={t.id} onChange={(e) => setSelected(e.target.value)} aria-label="編集する評価シート">
          {draft.templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.id === draft.defaultTemplateId ? "(既定)" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="quiet small" onClick={() => add()} disabled={draft.templates.length >= 20}>
          新しく作る
        </button>
        <button type="button" className="quiet small" onClick={() => add(t)} disabled={draft.templates.length >= 20}>
          複製
        </button>
        <button
          type="button"
          className="quiet small"
          disabled={t.id === draft.defaultTemplateId}
          onClick={() => setDraft({ ...draft, defaultTemplateId: t.id })}
        >
          既定にする
        </button>
        <button type="button" className="quiet small danger-text" disabled={draft.templates.length <= 1 || t.id === draft.defaultTemplateId} onClick={remove}>
          削除
        </button>
      </div>

      <div className="grid2">
        <Field label="評価シートの名前">
          <input value={t.name} maxLength={40} onChange={(e) => setTemplate({ name: e.target.value })} />
        </Field>
        <Field label="合格の目安(合計点)" hint="1〜5点。判定画面の集計に目安として表示します(合否は自動で決まりません)。空欄なら表示しません">
          <input
            type="number"
            min={1}
            max={5}
            step={0.1}
            value={t.passLine ?? ""}
            onChange={(e) => setTemplate({ passLine: e.target.value === "" ? null : Math.max(1, Math.min(5, Math.round(Number(e.target.value) * 10) / 10)) })}
          />
        </Field>
      </div>

      <h3>評価項目</h3>
      <p className="muted small">面接官が1〜5で評価する項目です。重みを大きくした項目ほど、合計点への影響が大きくなります。</p>
      <CriteriaEditor value={t.criteria} onChange={(criteria) => setTemplate({ criteria })} />

      <h3>質問と時間の目安</h3>
      <p className="muted small">録画中に「いまこの質問」と記録するボタンになります。時間の目安を入れると、録画画面に質問ごとの経過時間が出ます。</p>
      <QuestionPlanEditor value={t.questions} onChange={(questions) => setTemplate({ questions })} />

      <h3>評価の段階(1〜5の呼び方)</h3>
      <p className="muted small">すべての評価シートで共通です。</p>
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

function NoticesTab({ draft, setDraft }: TabProps) {
  const set = (k: Vote, patch: Partial<NoticeTemplate>) =>
    setDraft({ ...draft, notices: { ...draft.notices, [k]: { ...draft.notices[k], ...patch } } });
  return (
    <div className="panel pad form">
      <p className="muted small">
        判定のあとに、面接の詳細画面の「合否通知書」から印刷できる文書のひな形です。
        差し込める語: {NOTICE_PLACEHOLDERS.join(" ")}({"{宛名}"} は保護者の同意があれば保護者と本人の2行になります)。
      </p>
      {(["pass", "fail", "hold"] as Vote[]).map((k) => (
        <div key={k} className="notice-template">
          <h3>{VOTE_LABEL[k]}のとき</h3>
          <Field label="タイトル">
            <input value={draft.notices[k].title} maxLength={100} onChange={(e) => set(k, { title: e.target.value })} />
          </Field>
          <Field label="本文">
            <textarea rows={10} value={draft.notices[k].body} onChange={(e) => set(k, { body: e.target.value })} />
          </Field>
          <div className="row-actions left">
            <button className="quiet small" onClick={() => set(k, { ...DEFAULT_NOTICES[k] })}>
              初期の文面に戻す
            </button>
          </div>
        </div>
      ))}
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
      <Field label="判定が確定してから応募書類(添付ファイル)を消すまでの日数" hint="面接に添付した PDF・画像を削除します">
        <input
          type="number"
          min={1}
          max={3650}
          value={draft.retention.attachmentDaysAfterDecision}
          onChange={(e) =>
            setDraft({ ...draft, retention: { ...draft.retention, attachmentDaysAfterDecision: Number(e.target.value) } })
          }
        />
      </Field>
      <p className="muted small">削除は6時間ごとに自動で行います。保存した設定ですぐに実行する場合は下のボタンを押してください。</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="row-actions left">
        <button
          disabled={busy}
          onClick={async () => {
            const r = await run(() => api.runRetention());
            if (r) {
              toast(
                `期限を過ぎた録画 ${r.purged}件、未完了のアップロード ${r.staleRemoved}件、応募書類 ${r.attachmentsPurged}件を削除しました`,
              );
            }
          }}
        >
          保存期間の処理をいま実行する
        </button>
      </div>
    </div>
  );
}

function UsersTab() {
  const { reloadUsers, user: me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);

  const load = async () => {
    try {
      setUsers((await api.adminUsers()).users);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reload = async () => {
    await Promise.all([load(), reloadUsers()]);
  };
  if (!users) return <Loading />;

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
              <th>メール</th>
              <th>2段階認証</th>
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
                <td className="small">{u.email || <span className="muted">未登録</span>}</td>
                <td className="small">{u.totpEnabled ? <span className="ok-text">有効</span> : <span className="muted">—</span>}</td>
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
            await reload();
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
            await reload();
            setEditing(null);
            toast("ユーザーを更新しました");
          }}
        />
      )}
    </div>
  );
}

function UserForm({ user, isSelf, onClose, onSaved }: { user?: UserAccount; isSelf?: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [loginId, setLoginId] = useState(user?.loginId ?? "");
  const [role, setRole] = useState<string>(user?.role ?? "interviewer");
  const [password, setPassword] = useState("");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const { busy, error, run } = useAction();

  const submit = async () => {
    const ok = await run(async () => {
      if (user) {
        const patch: Partial<{ name: string; role: string; disabled: boolean; password: string; email: string }> = {};
        if (name !== user.name) patch.name = name;
        if (email.trim() !== user.email) patch.email = email.trim();
        if (role !== user.role) patch.role = role;
        if (disabled !== user.disabled) patch.disabled = disabled;
        if (password) patch.password = password;
        return api.updateUser(user.id, patch);
      }
      return api.createUser({ loginId, name, role, password, email: email.trim() });
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
        <Field label="メールアドレス" hint="お知らせのメールの宛先(任意)。本人も「アカウント」で変更できます">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" />
        </Field>
        <Field label="権限">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="interviewer">面接官</option>
            <option value="admin">管理者</option>
          </select>
        </Field>
        <Field label={user ? "パスワードの再設定" : "初期パスワード"} required={!user} hint={user ? "変更する場合のみ入力(8文字以上)。この人のほかの端末のログインは解除されます" : "8文字以上。本人に伝え、ログイン後に変更してもらってください"}>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="text" autoComplete="off" />
        </Field>
        {user?.totpEnabled && (
          <div className="feature-status">
            <span className="small">2段階認証: 有効</span>
            <button
              type="button"
              className="quiet small danger-text"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(`${user.name} の2段階認証を解除します。スマートフォンをなくした場合などに使います。本人は次のログインで設定し直してください。`)) return;
                const ok = await run(() => api.resetUserTotp(user.id));
                if (ok) await onSaved();
              }}
            >
              2段階認証を解除する
            </button>
          </div>
        )}
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
  notify_update: "お知らせの設定",
  totp_enable: "2段階認証の設定",
  totp_disable: "2段階認証の無効化",
  totp_recovery: "予備のコードの再発行",
  totp_reset: "2段階認証の解除",
  search: "検索",
  interview_export: "データの書き出し",
  mail_test: "テストメール",
  attachment_upload: "書類の添付",
  attachment_view: "書類の閲覧",
  attachment_delete: "書類の削除",
  consent_link_create: "同意のリンク作成",
  consent_link_revoke: "同意のリンク取り消し",
  consent_online: "オンラインの同意",
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
  live_view: "ライブ視聴",
  room_message: "面接室へのメッセージ",
  transcript_view: "文字起こしの閲覧",
  transcript_request: "文字起こしのやり直し",
  transcription_prepare: "文字起こしのモデルの取得",
  report_print: "記録票の印刷",
  notice_print: "合否通知書の印刷",
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
