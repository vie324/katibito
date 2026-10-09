// サーバーのビルド(server/main.ts → dist-server/main.js)。
// 共有コード(src/analysis, src/shared)ごと1ファイルにまとめ、実行時に node_modules を必要としない。

import { defineConfig } from "vite";

export default defineConfig({
  // public/(モデル・WASM)はクライアント側の dist/ にだけ入れる
  publicDir: false,
  build: {
    ssr: "server/main.ts",
    outDir: "dist-server",
    target: "node22",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: { format: "es", entryFileNames: "main.js" },
    },
  },
  ssr: { noExternal: true },
});
