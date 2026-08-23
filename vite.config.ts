import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 実行時に外部通信を発生させない。モデル・WASM・フォントはすべてローカル同梱。
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
