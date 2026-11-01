import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * 前端版本 = web/package.json 的 version，构建期注入，供「设置 → 关于」显示并与服务端对比。
 * 用 import.meta.dirname 而非 __dirname：Vite 8 的 native config loader 不支持 __dirname
 * （只在旧 loader 下靠 shim 生效），继续用会在后续大版本直接失败。
 */
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version?: string };

export default defineConfig({
  plugins: [react({ compiler: process.env.REACT_COMPILER === '1' })],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 15173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:13800',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
