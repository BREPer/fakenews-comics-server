import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyAccent, applyTheme, getStoredAccent, getStoredTheme } from './theme';
import './index.css';

// 首帧先按本地记住的主题/高亮色上色，避免浅色模式下先闪一下深色、或橙色闪一下再变蓝
applyTheme(getStoredTheme());
applyAccent(getStoredAccent());

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

/**
 * 注册 Service Worker（离线外壳 + 静态资源强缓存）。
 *
 * 三个前提缺一不可，否则静默跳过：
 *   1. 生产构建 —— 开发态 Vite 按模块伺服、文件名不带指纹，缓存住会拿到旧模块
 *   2. 安全上下文 —— 浏览器只在 https / localhost / 127.0.0.1 下暴露 SW；
 *      NAS 常见的 http://192.168.x.x 访问拿不到，属于平台限制，不是 bug
 *   3. 浏览器支持
 * 注册失败一律吞掉：PWA 是增强能力，绝不能因为它让应用起不来。
 * 放在 load 之后，不和首屏抢带宽。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const secure = location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (secure) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* 无 SW 不影响使用 */
      });
    });
  }
}
