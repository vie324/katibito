// クライアントとサーバーで共有する型(運用版)。
// ここは型のみ。DOM にも Node にも依存しない。

export type Role = "admin" | "interviewer";

export type UserPublic = {
  id: string;
  loginId: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
};

export type SessionInfo = {
  user: UserPublic | null;
  /** ユーザーが1人もいない(初期設定が必要) */
  needsSetup: boolean;
  orgName: string;
  version: string;
  /** サーバーで使える機能 */
  features: {
    /** 文字起こし(whisper.cpp があり、設定で有効) */
    transcription: boolean;
  };
};

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export type Criterion = {
  id: string;
  label: string;
  description: string;
  /** 合計点での重み(1〜5) */
  weight: number;
};

/** 質問と、その質問にかける時間の目安(分) */
export type QuestionPlan = {
  text: string;
  minutes: number | null;
};

/** 評価シート(面接の種類ごとの評価項目・質問) */
export type InterviewTemplate = {
  id: string;
  name: string;
  criteria: Criterion[];
  questions: QuestionPlan[];
  /** 合格の目安(重み付き平均点、1〜5)。null なら表示しない */
  passLine: number | null;
};

/** 合否通知書の文面 */
export type NoticeTemplate = { title: string; body: string };

export type Settings = {
  orgName: string;
  /** 同意文の {連絡先} に入る文言 */
  contact: string;
  /** 評価シート(1つ以上) */
  templates: InterviewTemplate[];
  /** 新しい面接で最初に選ばれている評価シート */
  defaultTemplateId: string;
  /** 評価スケールのラベル(1〜5の順) */
  ratingLabels: string[];
  consent: {
    title: string;
    /** {団体名} {保存日数} {連絡先} を差し込める */
    body: string;
  };
  retention: {
    /** 判定確定から録画を削除するまでの日数 */
    videoDaysAfterDecision: number;
    /** 判定が出ないまま録画を保管する上限日数 */
    videoDaysUndecided: number;
    /** 判定確定から応募書類(添付ファイル)を削除するまでの日数 */
    attachmentDaysAfterDecision: number;
  };
  /** 自分の評価を提出するまで他の評価者の評価・メモを見せない */
  blindEvaluation: boolean;
  recording: {
    videoBitsPerSecond: number;
    width: number;
    height: number;
  };
  /** Slack / Google Chat 互換の Incoming Webhook。null で無効 */
  webhookUrl: string | null;
  access: {
    /** 面接官が見られる面接: all = すべて / assigned = 面接官に選ばれた面接と自分が登録した面接だけ(管理者はすべて) */
    interviewerScope: "all" | "assigned";
  };
  transcription: {
    /** 録画の音声を文字起こしする(サーバーに whisper.cpp がある場合) */
    enabled: boolean;
  };
  /** 合否通知書の文面(判定の結果ごと) */
  notices: Record<Vote, NoticeTemplate>;
  security: {
    /** 再生中の映像に見ている人の名前を薄く重ねる */
    watermark: boolean;
    /** 管理者に2段階認証を必須にする */
    requireTotpForAdmins: boolean;
  };
  updatedAt: string;
  updatedBy: string | null;
};

// ---------------------------------------------------------------------------
// 面接
// ---------------------------------------------------------------------------

export type Candidate = {
  /** 表示名。イニシャルや受付番号でもよい */
  displayName: string;
  kana: string;
  age: number | null;
  /** 未成年(保護者の同意が必要) */
  minor: boolean;
  note: string;
};

export type ConsentRecord = {
  /** 録画への同意 */
  recording: boolean;
  /** 表情の計測(録画の解析)への同意 */
  analysis: boolean;
  candidateName: string;
  guardianName: string | null;
  guardianRelation: string | null;
  /** onscreen = 面接の場で画面に表示 / paper = 紙の同意書 / online = 事前に送ったリンクから本人・保護者が入力 */
  method: "onscreen" | "paper" | "online";
  /** 提示した同意文の SHA-256(先頭12桁) */
  consentVersion: string;
  /** 提示した同意文そのもの(差し込み済み) */
  consentText: string;
  obtainedBy: string;
  obtainedByName: string;
  obtainedAt: string;
  withdrawnAt: string | null;
  withdrawnScope: "analysis" | "all" | null;
  /** オンラインで取得したときの、同意のリンクの ID */
  linkId?: string | null;
};

/** 応募書類など、面接に添付したファイル */
export type AttachmentMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export type AttachmentMeta = {
  id: string;
  /** 元のファイル名 */
  name: string;
  /** 願書・作文などの種類(任意) */
  label: string;
  mime: AttachmentMime;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: string;
};

/**
 * 事前のオンライン同意のためのリンク(本人・保護者に送る)。
 * トークンそのものは作成時に1度だけ返し、サーバーには SHA-256 だけを保存する(応答では空文字)
 */
export type ConsentLink = {
  id: string;
  tokenHash: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};

/** 同意のリンクを開いた人に見せる内容(ログイン不要の画面) */
export type PublicConsentInfo = {
  orgName: string;
  contact: string;
  candidateName: string;
  scheduledAt: string | null;
  location: string;
  /** 未成年(保護者の同意が必要) */
  minor: boolean;
  /** open = 入力できる / done = 同意の記録が済んでいる / expired = 期限切れ / revoked = 取り消し済み */
  state: "open" | "done" | "expired" | "revoked";
  expiresAt: string;
  consent: { title: string; body: string; version: string };
};

export type MarkerKind = "question" | "bookmark";

export type Marker = {
  id: string;
  /** 録画開始からの ms */
  tMs: number;
  kind: MarkerKind;
  label: string;
};

export type RecordingStatus =
  | "uploading"   // チャンク受信中
  | "processing"  // 結合・インデックス作成中
  | "ready"       // 再生可能
  | "failed"
  | "purged"      // 保存期間経過で映像を削除(計測値は残す)
  | "deleted";    // 手動削除(計測値も削除)

export type RecordingMeta = {
  id: string;
  /**
   * 端末側の録画ID。再送しても重複作成しないためのキーで、送信の合言葉も兼ねる
   * (チャンク・完了の送信に必要)。サーバーからの応答では空文字
   */
  clientId: string;
  source: "live" | "file";
  status: RecordingStatus;
  mimeType: string;
  /** サーバー上の保存名(video.webm 等) */
  fileName: string | null;
  /** 取り込んだ動画の元のファイル名 */
  originalName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  chunkCount: number | null;
  sizeBytes: number | null;
  /** WebM に Cues/Duration を付与できたか(シークが速い) */
  indexed: boolean;
  /** 再生用の MP4(H.264)があるか。iPhone 等で再生するため(サーバーに ffmpeg がある場合) */
  mp4Ready: boolean;
  markers: Marker[];
  /** 表情計測の状態 */
  analysis: "none" | "ready" | "failed";
  /** 文字起こしの状態(サーバーに whisper.cpp がある場合) */
  transcript: "none" | "queued" | "running" | "ready" | "failed";
  transcriptError: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  error: string | null;
  purgedAt: string | null;
  /** 録画中(ライブで見られる)なら、その状態。応答だけに付く */
  live?: LiveInfo | null;
};

/** 文字起こし(録画の時刻つき) */
export type TranscriptSegment = { startMs: number; endMs: number; text: string };

export type Transcript = {
  language: string;
  model: string;
  createdAt: string;
  segments: TranscriptSegment[];
};

/** 文字起こしの準備状況(設定画面) */
export type TranscriptionStatus = {
  /** whisper-cli と ffmpeg があり、サーバーの設定で無効にされていない */
  available: boolean;
  /** 管理者の設定(文字起こしをする) */
  enabled: boolean;
  model: string;
  modelReady: boolean;
  /** モデルを取得中なら 0〜1 */
  downloading: number | null;
  /** いま処理中の録画の進み具合(0〜1) */
  progress: { interviewId: string; recordingId: string; fraction: number } | null;
  queued: number;
  error: string | null;
  /** 使えない理由 */
  reason: string | null;
};

/** 録画中の録画の状態(録画している端末から数秒ごとに届く) */
export type LiveInfo = {
  /** 録画を始めた時刻(サーバーの時計) */
  startedAt: string;
  /** いまの録画の経過時間(サーバーの推定) */
  elapsedMs: number;
  /** いまの質問 */
  question: string | null;
  updatedAt: string;
};

export type Vote = "pass" | "hold" | "fail";

export type Decision = {
  result: Vote;
  reason: string;
  decidedBy: string;
  decidedByName: string;
  decidedAt: string;
};

export type Interview = {
  id: string;
  candidate: Candidate;
  /** 同じ候補者の面接(一次・二次など)に共通のID */
  applicantId: string;
  /** 面接の段階(「一次面接」など。空でもよい) */
  round: string;
  scheduledAt: string | null;
  location: string;
  interviewerIds: string[];
  questions: string[];
  /** questions と同じ順の、質問ごとの時間の目安(分) */
  questionMinutes: (number | null)[];
  /** 使った評価シート。評価項目は面接ごとに写しを持つ(あとで評価シートを変えても過去の評価が崩れない) */
  templateId: string | null;
  templateName: string;
  criteria: Criterion[];
  passLine: number | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  consent: ConsentRecord | null;
  /** 同意が得られず録画せずに面接した */
  recordingDeclined: boolean;
  recordings: RecordingMeta[];
  decision: Decision | null;
  /** 応募書類などの添付ファイル */
  attachments: AttachmentMeta[];
  /** 事前のオンライン同意のために送ったリンク */
  consentLinks: ConsentLink[];
};

export type InterviewStatus =
  | "scheduled"   // 録画前
  | "uploading"   // 録画の送信・処理中
  | "evaluating"  // 評価入力中
  | "deciding"    // 評価が揃い、判定待ち
  | "decided";    // 判定済

export type InterviewListItem = {
  id: string;
  candidate: Candidate;
  applicantId: string;
  round: string;
  scheduledAt: string | null;
  location: string;
  interviewerIds: string[];
  createdAt: string;
  status: InterviewStatus;
  consent: { recording: boolean; analysis: boolean } | null;
  recordingDeclined: boolean;
  recordingCount: number;
  readyRecordingCount: number;
  durationMs: number | null;
  submittedCount: number;
  expectedCount: number;
  /** 録画中(ライブで見られる) */
  live: boolean;
  myEvaluation: "none" | "draft" | "submitted";
  votes: Record<Vote, number> | null;
  /** 提出済みの評価の重み付き平均点(1〜5)。非公開中は null */
  score: number | null;
  templateName: string;
  /** 質問の時間の目安の合計(分) */
  plannedMinutes: number | null;
  decision: Decision | null;
};

// ---------------------------------------------------------------------------
// 評価・メモ
// ---------------------------------------------------------------------------

export type Evaluation = {
  userId: string;
  userName: string;
  /** criterionId → 1〜5(未入力は null) */
  ratings: Record<string, number | null>;
  criterionComments: Record<string, string>;
  vote: Vote | null;
  comment: string;
  status: "draft" | "submitted";
  updatedAt: string;
  /** 最初に提出した日時(提出後に修正しても変わらない) */
  submittedAt: string | null;
  /** 提出後に内容を変更した回数と、最後に変更した日時 */
  revisions?: number;
  revisedAt?: string | null;
  /** ほかの評価者の評価が見える状態で修正したことがある(非公開ルールのもとでの修正の透明性のため) */
  revisedWhileOthersVisible?: boolean;
};

export type Note = {
  id: string;
  /** note = メモ / room = 面接室へのメッセージ(録画している端末に表示。評価の非公開の対象外) */
  kind?: "note" | "room";
  /** 録画に紐づくメモは recordingId と tMs を持つ。全体コメントは null */
  recordingId: string | null;
  tMs: number | null;
  text: string;
  userId: string;
  userName: string;
  createdAt: string;
};

export type EvaluationsView = {
  mine: Evaluation | null;
  /** 他の評価者の評価。非公開中は null */
  others: Evaluation[] | null;
  /** 非公開でも件数は見せる */
  othersSubmittedCount: number;
  othersVisible: boolean;
  /** 管理者なので見えている(自分の評価は未提出)。画面では「表示する」を押すまで伏せる */
  visibleBecauseAdmin: boolean;
  /** 非公開の理由(表示用) */
  hiddenReason: string | null;
};

export type NotesView = {
  notes: Note[];
  hiddenCount: number;
};

/** 同じ候補者のほかの面接(一次・二次など) */
export type RoundSummary = {
  id: string;
  round: string;
  scheduledAt: string | null;
  createdAt: string;
  status: InterviewStatus;
  decision: Vote | null;
};

export type InterviewDetail = {
  interview: Interview;
  status: InterviewStatus;
  /** 同じ候補者のほかの面接(閲覧できるものだけ) */
  otherRounds: RoundSummary[];
  interviewers: UserPublic[];
  evaluations: EvaluationsView;
  notes: NotesView;
  /** この面接の評価項目(面接ごとの写し) */
  criteria: Criterion[];
  ratingLabels: string[];
};

// ---------------------------------------------------------------------------
// 統計・監査
// ---------------------------------------------------------------------------

/**
 * 表情の指標の分布(これまでの面接。1面接 = 顔が最も長く映っていた録画1本)。
 * どの面接の値かは分からないよう、指標ごとに並べ替えた値だけを返す。件数が minN 未満なら値は返さない
 */
export type MetricDistribution = { n: number; values: Record<string, number[]> };

export type ExpressionCompare = {
  minN: number;
  /** この候補者(ほかの回の面接を含む)を除いた、これまでのすべての面接 */
  all: MetricDistribution;
  /** 同じ年代の面接(年齢が未入力なら null) */
  band: (MetricDistribution & { label: string }) | null;
};

/** 候補者の比較一覧の1行 */
export type CompareRow = {
  id: string;
  candidate: Pick<Candidate, "displayName" | "kana" | "age" | "minor">;
  applicantId: string;
  round: string;
  scheduledAt: string | null;
  createdAt: string;
  templateId: string | null;
  templateName: string;
  interviewerIds: string[];
  status: InterviewStatus;
  decision: Vote | null;
  submittedCount: number;
  expectedCount: number;
  /** 評価の非公開のルールで、ほかの人の評価が見えるか */
  visible: boolean;
  votes: Record<Vote, number> | null;
  /** 重み付き合計点の平均(1〜5)。非公開中は null */
  score: number | null;
  passLine: number | null;
  /** 評価項目ごとの平均。非公開中は null */
  criteria: { label: string; weight: number; avg: number | null }[] | null;
  /** 表情の計測(代表の録画の全体値)。計測なし・信頼度が低いときは null */
  expression: Record<string, number | null> | null;
};

/** 面接官ごとの評価の傾向 */
export type RaterStats = {
  userId: string;
  name: string;
  /** 提出した評価の数 */
  submitted: number;
  /** 自分の合計点の平均 */
  meanScore: number | null;
  /** ほかの面接官も評価した面接の数(差の計算に使えた数) */
  panelCount: number;
  /** ほかの面接官の平均点との差の平均(プラスなら高めにつける傾向) */
  meanDiff: number | null;
  /** 差の大きさ(絶対値)の平均 */
  meanAbsDiff: number | null;
  votes: Record<Vote, number>;
  /** 判定が出た面接で、自分の票が判定と同じだった数 */
  decisionAgreement: { n: number; agree: number };
  /** 評価項目(名前ごと)の、ほかの面接官との差の平均 */
  criteria: { label: string; n: number; meanDiff: number }[];
  /** 面接(録画の開始、なければ予定日時)から評価の提出までの時間の中央値(時間) */
  medianSubmitHours: number | null;
};

export type AuditEntry = {
  ts: string;
  userId: string | null;
  userName: string | null;
  action: string;
  interviewId: string | null;
  detail: string | null;
  ip: string | null;
};
