import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// 开发时把接口转发给正在运行的 Go 内核（默认 17800，可用 GAM_API 指定）。
const api = process.env.GAM_API || "http://127.0.0.1:17800";
const dir = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: resolve(dir, "../web"),
    emptyOutDir: true,
    target: "safari16",
    cssTarget: "safari16",
    rollupOptions: {
      input: {
        main: resolve(dir, "index.html"),
        mini: resolve(dir, "mini.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false, headers: { Host: new URL(api).host } },
      "/oauth": { target: api },
    },
  },
});
