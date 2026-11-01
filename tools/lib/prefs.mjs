/**
 * 探针专用：把「设备偏好」注入 localStorage（在页面脚本之前执行）。
 *
 * 背景：阅读偏好与外观已从服务端设置改为**按设备存**（2026-10-24），
 * 以前探针用 `PUT /api/settings {theme:'dark'}` 就能改主题，现在这个写入会被
 * 服务端忽略（10 个键进了 deprecatedKeys）。正确做法是让浏览器在加载应用前
 * 就带着这些 localStorage 值——用 CDP 的 addScriptToEvaluateOnNewDocument。
 *
 * 注意：这个模块只给 tools/ 下的探针用，不参与前端构建。
 */

/** 偏好键 → localStorage 键（与 app/web/src/utils/devicePrefs.ts 的 KEYS 对齐） */
const KEY = {
  theme: 'fakenews-theme',
  accent: 'fakenews-accent',
  readerMode: 'fn:readerMode',
  readDir: 'fn:readDir',
  fitMode: 'fn:fitMode',
  quality: 'fn:quality',
  preloadCount: 'fn:preloadCount',
  pageAnimation: 'fn:pageAnimation',
  pinchZoom: 'fn:pinchZoom',
  keepScreenOn: 'fn:keepScreenOn',
};

/** 生成注入脚本：先打迁移标记（探针不该消费真实数据），再写各项偏好 */
export function prefsSource(patch = {}) {
  const sets = [];
  for (const [k, v] of Object.entries(patch)) {
    const key = KEY[k];
    if (!key || v === undefined || v === null) continue;
    const val = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    sets.push(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(val)});`);
  }
  return `(function(){try{localStorage.setItem('fn:prefsMigrated','1');${sets.join('')}}catch(e){}})();`;
}

/**
 * 往一个 CDP 连接上叠加偏好。多次调用会累积（后加的脚本在每次加载时后执行，
 * 因此以最后一次为准）；调用方只需在导航前准备好完整的一组值。
 */
export async function injectPrefs(send, patch = {}) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: prefsSource(patch) });
}
