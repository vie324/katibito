// 管理系 API: 表情指標の比較用統計、操作ログ、CSV 出力、保存期間処理の手動実行。

import { pickRepresentative } from "../../src/analysis/expression";
import { COMPARABLE_METRICS, formatMetric, METRIC_META, QUALITY_LABEL } from "../../src/analysis/metricsMeta";
import { averageScore, criterionAverages } from "../../src/shared/score";
import { deriveStatus, STATUS_LABEL, submittedEvaluations, tallyVotes, VOTE_LABEL } from "../../src/shared/status";
import type { ExpressionStats } from "../../src/shared/types";
import { int } from "../../src/shared/validate";
import type { AppContext } from "../context";
import { attachmentHeader, HANDLED, HttpError, type Router } from "../http";
import { ensureModels, transcriptionStatus } from "../transcribe";
import { loadSummary } from "../recordings";
import { runRetention } from "../retention";
import { audit } from "./interviews";

async function representativeSummary(app: AppContext, iid: string) {
  const iv = app.store.interviews.get(iid);
  if (!iv) return null;
  const summaries = [];
  for (const rec of iv.recordings) {
    if (rec.analysis !== "ready") continue;
    const s = await loadSummary(app, iid, rec).catch(() => null);
    if (s) summaries.push(s);
  }
  return pickRepresentative(summaries);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // 表計算ソフトの数式として解釈されないようにする
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function jst(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export function registerAdminRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/stats/expression", "user", async (): Promise<ExpressionStats> => {
    const items: ExpressionStats["items"] = [];
    for (const iid of store.interviews.keys()) {
      const s = await representativeSummary(app, iid);
      // 品質「低」の計測は比較の母集団に入れない
      if (!s || s.quality.level === "low") continue;
      const values: Record<string, number | null> = {};
      for (const k of COMPARABLE_METRICS) values[k] = s.overall[k];
      items.push({ interviewId: iid, values });
    }
    return { items };
  });

  r.get("/api/admin/transcription", "admin", async () => ({ status: await transcriptionStatus(app) }));

  // 文字起こしのモデルを先に取得しておく(最初の録画を待たずに)
  r.post("/api/admin/transcription/prepare", "admin", async (c) => {
    const status = await transcriptionStatus(app);
    if (!status.available) throw new HttpError(409, status.reason ?? "サーバーで文字起こしを使えません");
    void ensureModels(app).catch((e) => console.warn("[transcribe] モデルを取得できません", (e as Error).message));
    await audit(app, c, "transcription_prepare", null);
    return { status: await transcriptionStatus(app) };
  });

  r.get("/api/audit", "admin", async (c) => {
    const limit = int(c.query.get("limit") ?? undefined, "件数", { min: 1, max: 2000, optional: true }) ?? 300;
    return { entries: await app.audit.read(limit) };
  });

  r.post("/api/admin/retention/run", "admin", async (c) => {
    const res = await runRetention(app);
    await audit(app, c, "retention_run", null, `purged=${res.purged} stale=${res.staleRemoved}`);
    return res;
  });

  r.get("/api/export/interviews.csv", "admin", async (c) => {
    const ivs = [...store.interviews.values()].sort((a, b) =>
      (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt),
    );
    // 評価シートごとに項目が違うため、項目名ごとに列を作る(同じ名前の項目は同じ列)
    const labels: string[] = [];
    for (const iv of ivs) for (const cr of iv.criteria) if (!labels.includes(cr.label)) labels.push(cr.label);
    const header = [
      "面接ID", "候補者", "ふりがな", "年齢", "未成年", "面接日時", "場所", "面接官", "状態",
      "録画同意", "計測同意", "合格票", "保留票", "不合格票", "提出数",
      "評価シート", "合計点(重み付き平均)",
      ...labels.map((l) => `${l}(平均)`),
      "判定", "判定日時", "判定者", "判定理由",
      ...COMPARABLE_METRICS.map((k) => `${METRIC_META[k].label}${METRIC_META[k].unit ? `(${METRIC_META[k].unit})` : ""}`),
      "顔の計測率(%)", "計測の信頼度",
    ];
    const rows: string[] = [header.map(csvCell).join(",")];
    for (const iv of ivs) {
      const evals = store.evaluationsOf(iv.id);
      const submitted = submittedEvaluations(evals);
      const votes = tallyVotes(evals);
      const avgs = criterionAverages(iv.criteria, evals);
      const avgByLabel = (label: string) => {
        const cr = iv.criteria.find((x) => x.label === label);
        const v = cr ? avgs[cr.id] : null;
        return typeof v === "number" ? v.toFixed(2) : "";
      };
      const score = averageScore(iv.criteria, evals);
      const s = await representativeSummary(app, iv.id);
      rows.push(
        [
          iv.id,
          iv.candidate.displayName,
          iv.candidate.kana,
          iv.candidate.age ?? "",
          iv.candidate.minor ? "はい" : "",
          jst(iv.scheduledAt),
          iv.location,
          iv.interviewerIds.map((u) => store.userName(u)).join(" / "),
          STATUS_LABEL[deriveStatus(iv, evals)],
          iv.consent ? (iv.consent.recording ? "あり" : "なし") : "未記録",
          iv.consent ? (iv.consent.analysis ? "あり" : "なし") : "未記録",
          votes.pass,
          votes.hold,
          votes.fail,
          submitted.length,
          iv.templateName,
          score === null ? "" : score.toFixed(2),
          ...labels.map(avgByLabel),
          iv.decision ? VOTE_LABEL[iv.decision.result] : "",
          jst(iv.decision?.decidedAt ?? null),
          iv.decision?.decidedByName ?? "",
          iv.decision?.reason ?? "",
          ...COMPARABLE_METRICS.map((k) => (s ? formatMetric(k, s.overall[k]).replace("—", "") : "")),
          s ? formatMetric("faceDetectRate", s.overall.faceDetectRate) : "",
          s ? QUALITY_LABEL[s.quality.level] : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const body = Buffer.from("﻿" + rows.join("\r\n") + "\r\n", "utf8");
    await audit(app, c, "export_csv", null, `${ivs.length} rows`);
    c.res.statusCode = 200;
    c.res.setHeader("Content-Type", "text/csv; charset=utf-8");
    c.res.setHeader("Content-Disposition", attachmentHeader(`面接一覧_${new Date().toISOString().slice(0, 10)}.csv`));
    c.res.setHeader("Cache-Control", "no-store");
    c.res.setHeader("Content-Length", body.length);
    c.res.end(body);
    return HANDLED;
  });
}
