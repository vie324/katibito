// サーバーの起動点。npm start(dist-server/main.js)/ npm run dev(vite-node)から呼ばれる。

import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await createApp(config);
const addr = await app.listen();

console.log(`[server] http://${addr.address === "0.0.0.0" ? "localhost" : addr.address}:${addr.port} で待ち受けています`);
console.log(`[server] データ: ${config.dataDir}`);
if (!config.staticDir) console.log("[server] クライアント未ビルドのため API のみ提供します");

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal} を受け取りました。停止します`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await app.close().catch((e) => console.error(e));
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
