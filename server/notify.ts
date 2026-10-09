// Incoming Webhook への通知(Slack / Google Chat 互換の {"text": "..."})。
// 失敗しても本処理は止めない。

export async function sendWebhook(url: string | null, text: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`[notify] webhook が ${res.status} を返しました`);
    return res.ok;
  } catch (e) {
    console.warn("[notify] webhook の送信に失敗", (e as Error).message);
    return false;
  }
}

export function isAllowedWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}
