import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * 构建产物直接输出到 ../public —— 后端 server.js 原样托管 public 目录，
 * 所以后端一个字都不用改。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // 不手工指定 manualChunks：交给 Vite 按动态导入自动分包。
    // 手工把 recharts 固定成命名 chunk 时，它会被当成入口的共享依赖 preload 进首屏，
    // 结果登录页也要先下载 400KB 图表库。
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
})
