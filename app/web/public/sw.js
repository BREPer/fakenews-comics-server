/*
 * 肥牛漫画 Service Worker —— 只为「秒开 + 弱网/断网仍能进应用」服务，不做 API 缓存。
 *
 * 策略（都是刻意的，改动前先读一遍）：
 *   /api/**            完全不拦截。列表接口已经有 ETag 协商缓存，浏览器自己会发
 *                      If-None-Match 拿 304；SW 再插一层只会让「收藏/进度刚改完却
 *                      看到旧数据」这类问题变得难以排查。阅读进度是不能缓存的。
 *   导航请求（HTML）   network-first：一次部署就能立刻生效，断网时回落到缓存的
 *                      /index.html（应用外壳）。
 *   /assets/**         cache-first：文件名带内容指纹，内容变了 URL 就变了，
 *                      缓存一年都不会错。这也是首屏 JS/CSS 不再重复下载的关键。
 *   （已无 /status/ 特例）吉祥物插画原来放在 public/status/，文件名不带指纹，
 *                      只能对 /status/** 用 network-first——换来「换素材立刻生效」，
 *                      代价是**每次访问都要重下插画**（弱网首屏最吃亏的就是这一张）。
 *                      2026-10-28 把素材移进 src/assets/status 交给 Vite 打内容指纹，
 *                      于是落进 /assets/** cache-first：重复访问零网络，换素材照样立刻
 *                      生效（hash 变即 URL 变）。这个取舍被消掉了，特例已删。
 *   其余同源静态       stale-while-revalidate：图标、manifest 这类。
 *
 * 安全边界：本文件只在 PROD 且是安全上下文（https / localhost）时才会被注册
 * （见 main.tsx）。NAS 上常见的 http://192.168.x.x 访问拿不到 SW 能力，
 * 那里退化成普通网页，PWA 清单（添加到主屏）仍然有效。
 */

// 改静态资源的缓存策略时一并 +1：旧客户端 activate 时会删掉不在这个集合里的
// fc-* 缓存，否则它们手里已经缓存的旧插画会一直被用到下次策略变更为止。
// v4（2026-10-28）：吉祥物插画移进 /assets/（带指纹），删除 /status/ 特例，
// 顺手清掉老客户端里那份不再被引用的 /status/ 缓存。
const VERSION = 'v4';
const SHELL_CACHE = `fc-shell-${VERSION}`;
const STATIC_CACHE = `fc-static-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/logo.webp', '/logo.png', '/pwa-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add：某个文件缺失（例如换了图标名）不能让整次安装失败
      await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('fc-') && !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** 只缓存「成功 + 同源」的响应，避免把 500 页面或 opaque 响应固化下来 */
function cacheable(res) {
  return res && res.ok && res.type === 'basic';
}

/**
 * 写入静态缓存，并顺手做上限回收。
 *
 * 为什么需要回收：assets 的文件名带内容指纹，每次发版都是一批新 URL，
 * 而 SW 本身只有 VERSION 变化才会重新 activate（正常发版不会动它），
 * 于是旧指纹的文件会一直留在缓存里。实测一次发版残留 130KB 左右，
 * 攒几十次就是几十 MB —— 对 NAS 上这点存储不算什么，但没有上限的缓存不是好习惯。
 * 这里只保留了条目序（cache.keys() 按插入顺序），超限就从最老的开始删。
 */
const STATIC_MAX_ENTRIES = 80;
async function putStatic(request, response) {
  const cache = await caches.open(STATIC_CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  if (keys.length > STATIC_MAX_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - STATIC_MAX_ENTRIES).map((k) => cache.delete(k)));
  }
}

async function networkFirstShell(request) {
  try {
    const res = await fetch(request);
    if (cacheable(res)) {
      const cache = await caches.open(SHELL_CACHE);
      // 统一用 '/' 作为键：SPA 下 /comic/xxx 回的也是同一份 index.html
      void cache.put('/', res.clone());
    }
    return res;
  } catch {
    const cached = (await caches.match('/')) || (await caches.match('/index.html'));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>肥牛漫画</title>' +
        '<body style="font:15px/1.6 system-ui;padding:40px;text-align:center;color:#6b7280">' +
        '离线状态，且本机还没有缓存过应用外壳。<br>连上 NAS 后刷新即可。</body>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) void putStatic(request, res.clone());
  return res;
}

/**
 * 注：原有 `networkFirstStatic`（给不带内容指纹的静态资源用，唯一调用方是
 * /status/ 插画）已随 2026-10-28 的指纹化一并删除。以后若再出现「手替换同名文件」
 * 的资源，要么走 Vite 资源管线拿 hash，要么把这段 network-first 加回来 ——
 * 别退回到「每次访问都重下」的老路。
 */

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (cacheable(res)) void putStatic(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API 一律走网络（含 ETag 304），SW 不参与
  if (url.pathname.startsWith('/api/')) return;
  // 阅读器的图片流也在 /api 下，上面已经放行

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
