// 設定の初期値。管理者が「設定」画面で変更できる。

import { DEFAULT_NOTICES } from "./notice";
import type { Criterion, InterviewTemplate, QuestionPlan, Settings } from "./types";

export const DEFAULT_CONSENT_TITLE = "面接の録画と表情の計測についてのお願い";

export const DEFAULT_CONSENT_BODY = `{団体名}では、面接の内容を、その場にいない担当者も含めて公平に確認するため、面接の様子をビデオで録画させていただきたいと考えています。

1. 録画の目的
・面接に同席できない担当者が、面接の様子を確認するため(録画中に数秒遅れで見ることもあります)
・面接官どうしで、評価のすり合わせを行うため
・録画の音声をコンピューターで文字にして(文字起こし)、確認に使うため。文字起こしは録画を保管しているサーバーの中で行い、外部のサービスには送りません

2. 表情の計測について
録画した映像から、笑顔や眉の動き、うなずきなどの「表情の動き」をコンピューターで数値にし、選考の参考資料のひとつとして使います。
・表情の数値だけで合否を決めることはありません。合否は面接官の評価をもとに話し合って決めます。
・表情の出方には個人差があり、緊張などでも変わることを前提に扱います。
・年齢や性別などを推定することはありません。

3. 録画データの取り扱い
・録画と計測結果を見ることができるのは、選考に関わる担当者だけです。
・第三者に提供することはありません。
・録画(音声の文字起こしを含む)は、選考の結果が決まってから{保存日数}日以内に削除します。表情の計測結果(数値)と評価の記録は、選考の記録として保管します。

4. 同意しない場合・あとから取り消す場合
・録画や計測に同意いただけない場合も、面接は通常どおり行います。同意しないことで不利になることはありません。
・同意はあとから取り消すことができます。取り消しのご連絡をいただいた場合、録画と計測結果を削除します。

お問い合わせ・取り消しの連絡先: {連絡先}`;

export const DEFAULT_RATING_LABELS = ["不十分", "やや不十分", "標準", "良い", "非常に良い"];

export const DEFAULT_CRITERIA: Criterion[] = [
  { id: "manner", label: "あいさつ・マナー", description: "入退室、あいさつ、言葉づかい", weight: 1 },
  { id: "response", label: "受け答え", description: "質問を理解し、自分の言葉で答えられているか", weight: 1 },
  { id: "motivation", label: "意欲・熱意", description: "取り組みたいこと、目標の具体性", weight: 1 },
  { id: "cooperation", label: "人柄・協調性", description: "周囲と関わる姿勢、素直さ", weight: 1 },
  { id: "expression", label: "表現力", description: "伝え方、話の分かりやすさ", weight: 1 },
];

export const DEFAULT_QUESTIONS: QuestionPlan[] = [
  { text: "自己紹介", minutes: 2 },
  { text: "志望理由", minutes: 3 },
  { text: "最近がんばったこと", minutes: 3 },
  { text: "得意なこと・好きなこと", minutes: 3 },
  { text: "最後に質問", minutes: 2 },
];

export const DEFAULT_TEMPLATE_ID = "standard";

export function defaultTemplate(): InterviewTemplate {
  return {
    id: DEFAULT_TEMPLATE_ID,
    name: "標準",
    criteria: DEFAULT_CRITERIA.map((c) => ({ ...c })),
    questions: DEFAULT_QUESTIONS.map((q) => ({ ...q })),
    passLine: null,
  };
}

export function defaultSettings(now = new Date().toISOString()): Settings {
  return {
    orgName: "",
    contact: "",
    templates: [defaultTemplate()],
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    ratingLabels: [...DEFAULT_RATING_LABELS],
    consent: { title: DEFAULT_CONSENT_TITLE, body: DEFAULT_CONSENT_BODY },
    retention: { videoDaysAfterDecision: 90, videoDaysUndecided: 180, attachmentDaysAfterDecision: 365 },
    blindEvaluation: true,
    recording: { videoBitsPerSecond: 1_000_000, width: 1280, height: 720 },
    webhookUrl: null,
    access: { interviewerScope: "all" },
    transcription: { enabled: true },
    notices: structuredClone(DEFAULT_NOTICES),
    security: { watermark: true, requireTotpForAdmins: false },
    updatedAt: now,
    updatedBy: null,
  };
}

/** 録画画質の選択肢(設定画面) */
export const RECORDING_PRESETS = [
  { label: "標準(720p・1時間あたり約480MB)", videoBitsPerSecond: 1_000_000, width: 1280, height: 720 },
  { label: "高画質(720p・1時間あたり約1.2GB)", videoBitsPerSecond: 2_500_000, width: 1280, height: 720 },
  { label: "軽量(480p・1時間あたり約300MB)", videoBitsPerSecond: 600_000, width: 854, height: 480 },
] as const;
