/// <reference types="vite/client" />

/** 构建期注入的全局常量（见 vite.config.ts 的 define） */

/** 前端版本号（来自 app/web/package.json），用于「设置 → 关于」与服务端版本对比 */
declare const __APP_VERSION__: string;
