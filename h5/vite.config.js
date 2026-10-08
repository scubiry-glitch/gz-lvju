import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// @ke/morph 是内网私有包：装到了就用真包（package.json 的 module 指向不存在的
// out/main.js，强制走 main=es/）；预览机等装不到的环境回落 src/lib/morph-shim.js
const MORPH_PKG = path.resolve(__dirname, 'node_modules/@ke/morph/es/index.js');
const morphAlias = fs.existsSync(MORPH_PKG)
  ? MORPH_PKG
  : path.resolve(__dirname, 'src/lib/morph-shim.js');
if (morphAlias !== MORPH_PKG) {
  console.warn('[h5] @ke/morph 未安装（内网私有包），本次构建使用 morph-shim 兜底；登录跳转为等价实现、非官方 SDK');
}

// 生产挂载在站点 /h5/*；开发时 vite 自带 /h5 base，代理 API 到本地 app.js
export default defineConfig({
  base: '/h5/',
  plugins: [react()],
  resolve: {
    alias: {
      '@ke/morph': morphAlias,
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
