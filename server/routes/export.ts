// 候補者のデータの書き出し(管理者)。開示の求めへの対応や、記録の引き継ぎのため、
// 面接の記録・同意・評価・メモ・録画・表情の集計・文字起こし・応募書類を1つの ZIP にまとめる。

import { stat } from "node:fs/promises";
import path from "node:path";
import { formatClockMs } from "../../src/shared/time";
import type { Interview, Transcript } from "../../src/shared/types";
import { attachmentFile } from "../attachments";
import type { AppContext } from "../context";
import { attachmentHeader, HANDLED, type Router } from "../http";
import { SUMMARY_FILE } from "../recordings";
import { MP4_FILE } from "../transcode";
import { readTranscript } from "../transcribe";
import { ZIP_MAX_BYTES, ZipWriter } from "../zip";
import { audit, getInterview } from "./interviews";

/** フォルダ名・ファイル名に使えない文字を除く */
export function safeName(s: string, max = 60): string {
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, max);
  return cleaned || "_";
}

function jstDay(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 日本時間の日時(2026/10/12 10:00) */
function jstTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 書き出し用の面接の記録(端末の録画ID・リンクのハッシュは含めない) */
function interviewForExport(iv: Interview) {
  return {
    ...iv,
    recordings: iv.recordings.map((r) => ({ ...r, clientId: "", live: undefined })),
    consentLinks: iv.consentLinks.map((l) => ({ ...l, tokenHash: "" })),
  };
}

function transcriptText(t: Transcript): string {
  return t.segments.map((s) => `[${formatClockMs(s.startMs)}] ${s.text}`).join("\n") + "\n";
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

export function registerExportRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/interviews/:id/export.zip", "admin", async (c) => {
    const base = getInterview(app, c.params.id);
    const all = c.query.get("scope") === "applicant";
    const ivs = (all ? [...store.interviews.values()].filter((x) => x.applicantId === base.applicantId) : [base]).sort((a, b) =>
      (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt),
    );
    const root = safeName(`${base.candidate.displayName}_${jstDay(new Date().toISOString())}`);
    // 途中で受け取りが止まっても、書き出したことは残す(書き出しを始める前に記録する)
    await audit(app, c, "interview_export", base.id, `${all ? "applicant" : "interview"} n=${ivs.length}`);

    c.res.statusCode = 200;
    c.res.setHeader("Content-Type", "application/zip");
    c.res.setHeader("Content-Disposition", attachmentHeader(`${root}.zip`));
    c.res.setHeader("Cache-Control", "no-store");
    const zip = new ZipWriter(c.res);
    const skipped: string[] = [];
    const lines: string[] = [];
    // 大きなファイルを入れる前に、4GB の上限を超えないか確かめる
    const addLarge = async (name: string, file: string) => {
      const size = await sizeOf(file);
      if (size === null) return false;
      if (zip.size + size > ZIP_MAX_BYTES) {
        skipped.push(`${name}(${Math.round(size / 1024 / 1024)}MB)`);
        return false;
      }
      await zip.addFile(name, file);
      return true;
    };

    for (const [i, iv] of ivs.entries()) {
      const dir = `${root}/${String(i + 1).padStart(2, "0")}_${safeName(iv.round || "面接", 20)}_${jstDay(iv.scheduledAt ?? iv.createdAt)}`;
      lines.push(`${dir}/ … ${iv.round || "面接"}(${jstTime(iv.scheduledAt ?? iv.createdAt)})`);
      await zip.addBuffer(`${dir}/interview.json`, JSON.stringify(interviewForExport(iv), null, 2));
      if (iv.consent) {
        const c0 = iv.consent;
        await zip.addBuffer(
          `${dir}/同意.txt`,
          [
            `録画: ${c0.recording ? "同意" : "不同意"}`,
            `表情の計測: ${c0.analysis ? "同意" : "不同意"}`,
            `本人: ${c0.candidateName}`,
            c0.guardianName ? `保護者: ${c0.guardianName}${c0.guardianRelation ? `(${c0.guardianRelation})` : ""}` : "",
            `方法: ${c0.method === "paper" ? "紙の同意書" : c0.method === "online" ? "オンライン" : "画面"}`,
            `記録: ${jstTime(c0.obtainedAt)}(${c0.obtainedByName})`,
            c0.withdrawnAt ? `取り消し: ${jstTime(c0.withdrawnAt)}(${c0.withdrawnScope === "all" ? "すべて" : "表情の計測"})` : "",
            "",
            "--- 提示した同意文 ---",
            c0.consentText,
            "",
          ]
            .filter((l) => l !== "")
            .join("\n"),
        );
      }
      await zip.addBuffer(`${dir}/evaluations.json`, JSON.stringify(store.evaluationsOf(iv.id), null, 2));
      await zip.addBuffer(`${dir}/notes.json`, JSON.stringify(store.notesOf(iv.id), null, 2));

      for (const [n, rec] of iv.recordings.entries()) {
        if (rec.status === "deleted") continue;
        const rdir = path.posix.join(dir, "recordings");
        const prefix = `${String(n + 1).padStart(2, "0")}`;
        const recDir = store.recordingDir(iv.id, rec.id);
        if (rec.status === "ready" && rec.fileName) {
          // 再生用の MP4 があれば、元の WebM より小さく扱いやすいことが多いが、元の録画を正とする
          await addLarge(`${rdir}/${prefix}_録画${path.extname(rec.fileName) || ".webm"}`, path.join(recDir, rec.fileName));
        } else if (rec.status === "ready" && rec.mp4Ready) {
          await addLarge(`${rdir}/${prefix}_録画.mp4`, path.join(recDir, MP4_FILE));
        }
        if (rec.analysis === "ready" && (await sizeOf(path.join(recDir, SUMMARY_FILE))) !== null) {
          await zip.addFile(`${rdir}/${prefix}_表情の集計.json`, path.join(recDir, SUMMARY_FILE));
        }
        if (rec.transcript === "ready") {
          const t = await readTranscript(app, iv.id, rec.id).catch(() => null);
          if (t) await zip.addBuffer(`${rdir}/${prefix}_文字起こし.txt`, transcriptText(t));
        }
      }

      for (const a of iv.attachments) {
        await addLarge(`${dir}/応募書類/${safeName(a.label ? `${a.label}_${a.name}` : a.name, 100)}`, attachmentFile(app, iv.id, a));
      }
    }

    await zip.addBuffer(
      `${root}/はじめにお読みください.txt`,
      [
        `${store.settings.orgName || "面接記録"} — ${base.candidate.displayName} さんの面接の記録`,
        `書き出した日時: ${jstTime(new Date().toISOString())}(${c.user!.name})`,
        "",
        "個人情報を含みます。受け渡し・保管・廃棄の方法に注意してください。",
        "",
        "内容:",
        ...lines,
        "  interview.json … 面接の登録内容・同意・録画の情報・判定",
        "  同意.txt … 同意の内容と、提示した同意文",
        "  evaluations.json / notes.json … 面接官の評価とメモ",
        "  recordings/ … 録画・表情の集計(数値)・文字起こし",
        "  応募書類/ … 添付された書類",
        ...(skipped.length > 0
          ? ["", "大きすぎるため含めていないファイル(画面から個別に保存してください):", ...skipped.map((s) => `  ${s}`)]
          : []),
        "",
      ].join("\n"),
    );
    await zip.finish();
    return HANDLED;
  });
}
