import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const API_TARGET = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  // 実行時に外部通信を発生させない。モデル・WASM・フォントはすべてローカル同梱。
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  // 開発時は API サーバー(npm run dev が同時に起動)へ転送する
  server: {
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  preview: {
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
