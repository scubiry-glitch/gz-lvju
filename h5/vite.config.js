import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 生产挂载在站点 /h5/*；开发时 vite 自带 /h5 base，代理 API 到本地 app.js
export default defineConfig({
  base: '/h5/',
  plugins: [react()],
  resolve: {
    // @ke/morph package.json 的 module 指向不存在的 out/main.js，强制走 main=es/
    alias: {
      '@ke/morph': path.resolve(__dirname, 'node_modules/@ke/morph/es/index.js'),
    },
  },
  optimizeDeps: {
    include: ['@ke/morph', '@babel/runtime/helpers/interopRequireDefault'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8766', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:8766', changeOrigin: true },
    },
  },
});
