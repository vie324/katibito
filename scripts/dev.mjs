// 開発用: API サーバー(変更を監視して再起動)と Vite の開発サーバーを同時に起動する。
// 画面は http://localhost:5173 。データは ./data-dev に保存される。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.API_PORT ?? "8787";
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

const children = [];
function run(cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[dev] ${path.basename(cmd)} が終了しました (${code})`);
  });
  children.push(child);
  return child;
}

await new Promise((resolve, reject) => {
  const v = spawn(process.execPath, [path.join(root, "scripts", "vendor-assets.mjs")], { cwd: root, stdio: "inherit" });
  v.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("vendor に失敗しました"))));
});

run(bin("vite-node"), ["--watch", "server/main.ts"], {
  PORT: apiPort,
  HOST: "127.0.0.1",
  DATA_DIR: process.env.DATA_DIR ?? path.join(root, "data-dev"),
  STATIC_DIR: "",
});
run(bin("vite"), [], { API_PORT: apiPort });

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
