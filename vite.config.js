import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 只负责渲染进程 (src/)。打包后产物在 dist/，由 Electron 以 file:// 加载。
// base: './' 是必须的，否则 file:// 协议下绝对路径资源会 404。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:43117',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:43117',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
})
