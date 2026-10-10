// サービスワーカー(ホーム画面に追加して使うため)。
// 面接の記録や録画は端末に保存しない(キャッシュしない)。画面を開こうとして通信できないときだけ、
// 「接続できません」の案内を出す。API・録画の送信・映像の再生にはいっさい関与しない。

const OFFLINE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>面接記録</title>
<style>body{margin:0;background:#14171c;color:#e8e6e1;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}p{color:#8a9099;font-size:14px;line-height:1.8}button{margin-top:16px;padding:10px 20px;background:none;border:1px solid #e8a33d;color:#e8a33d;font-size:15px}</style></head>
<body><div><h1 style="font-size:20px">サーバーに接続できません</h1><p>通信できる場所で、もう一度開いてください。<br>録画中のデータは、この端末に残っていれば次に開いたときに続きから送信します。</p><button onclick="location.reload()">再読み込み</button></div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // 画面の移動だけを扱う(それ以外は何もせず、ブラウザが通常どおり通信する)
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }),
    ),
  );
});
