import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 生产挂载在站点 /h5/*；开发时 vite 自带 /h5 base，代理 API 到本地 app.js
export default defineConfig({
  base: '/h5/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8766', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:8766', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
