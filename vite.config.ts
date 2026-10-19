import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Tauri 需要的配置
export default defineConfig({
  plugins: [vue()],
  // Tauri 期望固定端口
  server: {
    port: 1420,
    strictPort: true,
  },
  // 以相对路径加载资源，兼容 Tauri 的自定义协议
  base: "./",
  build: {
    // Tauri 用的是 esbuild，不需要 Terser
    target: "es2021",
  },
  clearScreen: false,
});
