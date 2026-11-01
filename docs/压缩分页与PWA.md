# 压缩、分页与 PWA（2026-10-25）

> 本轮范围：API 压缩 / 列表分页 / 错误态 / 扫描提示 / ETag / PWA。

本轮全部围绕「用户能感觉到的东西」，先用 `tools/perf_audit.mjs`（390×844，Slow-4G）
体检，再按收益排序逐项改。所有数字都是本机实测（夹具 512 本）。

## 起点：体检发现的 4 个硬问题

| 编号 | 现象 | 量化 |
|---|---|---|
| P1-1 | 列表写死 `pageSize=120`，`hasMore` 服务端一直在返回但前端从未读过 | 512 本的库有 392 本**没有任何入口** |
| P1-2 | `/api` 响应完全不压缩，也没有任何缓存验证 | `/api/comics?pageSize=120` 58,517B；`/api/history?limit=100` 60,294B |
| P2-3 | 首页没有 `isError` 分支 | 请求失败被渲染成「还没有漫画」，且无重试 |
| P2-4 | 扫描进行中首页无提示 | 首扫期间用户看到空库，会怀疑导入失败 |

基线（Slow-4G）：FCP 712ms / 首卡 2366ms / LCP 2740ms。

## 1. API 压缩 + 弱 ETag（`internal/httputil/compress.go`）

一个中间件同时做两件事，包在 `AuthGate` 外层（401 信封也走同一条路）：

- **gzip**：JSON / `text/*`、状态 200、body ≥1KB 才压（小包压完更大，纯亏 CPU）
- **弱 ETag + `Cache-Control: no-cache`**：存下但每次回源验证，命中 `If-None-Match` → 304
- **直通**：图片、`206`/`Content-Range`、已有 `Content-Encoding`、写请求

关键实现细节（都是踩过才知道的）：

1. **隐式 `WriteHeader` 必须延后判定**：封面 / 页面流接口不调用 `WriteHeader`，直接
   `Write`。第一版只在 `WriteHeader` 里判定 `content-type`，结果封面被整张读进内存
   还挂了 ETag；页面流最大几 MB，等于每张页图多一次无谓分配。修法：`headerSeen`
   标记，在首次 `Write` 时补判定（`TestCompressPassthrough/image` 覆盖）。
2. **ETag 带 `-gz` 后缀**：同一份数据 gzip / identity 字节不同，共用 ETag 会让
   「先拿 gzip、后要 identity」的客户端收到不该有的 304。
3. **identity 响应显式给 `content-length`**：否则退化成 chunked，浏览器不知道总量。
4. **超大响应（>8MB）放弃 ETag**：`/api/backup/export` 之类不能为了算哈希把整包留在内存。

实测：

| 接口 | 明文 | gzip | 变化 |
|---|---|---|---|
| `/api/comics?pageSize=36` | 18,124B | 2,281B | **-87%** |
| `/api/comics?pageSize=120` | 58,517B | 5,826B | -90% |
| `/api/history?limit=100` | 60,294B | 5,739B | -90% |
| 二次请求（`If-None-Match` 命中） | — | 0B | 304 |

## 2. 分页 / 无限滚动（首屏 36 条）

`useComics` 从 `useQuery` 改成 `useInfiniteQuery`，`LIST_PAGE_SIZE = 36`
（手机 3 列 × 12 行）；`useInfiniteSentinel` 用 `IntersectionObserver`
（`rootMargin: 600px`）在离底一屏时预取。

- 查询 key 仍是 `['comics', …]` 前缀，`invalidateQueries({ queryKey: ['comics'] })`
  这类既有失效逻辑一行不用改
- `placeholderData: keepPreviousData`：切筛选/排序时不闪骨架
- 哨兵元素常驻，`enabled = hasMore && !isFetchingNextPage`：加载完成后重新 observe
  会立刻回调一次，因此「一屏还没填满」会连续续拉，直到填满或没有更多
- 底部只在「正在拉」和「确实跨过页且到末页」时出字；一页装完的小结果集不显示任何东西

首屏列表请求 58,517B → 18,124B（再叠加 gzip = **2,281B，-96%**）。

## 3. 错误态与重试

`EmptyState` 之外新增 `ErrorState`（红底 + 原始 message + 重试按钮），接入：

- 首页列表、搜索页、书架（收藏与阅读记录分开）
- 详情页：以前请求失败和「漫画被删」共用一句「漫画不存在 / 可能已被移动或删除」，
  断网时会让人以为书没了
- 首页「继续阅读」：只有 `data === undefined` 时出骨架，请求失败必须撤掉，
  否则骨架屏永久停在那里

## 4. 扫描进行中的首页提示

`useScanWatch(enabled, idleMs=15s)`：空闲 15s 轮询、`running` 时 800ms 快轮询；
`running → 结束` 那一刻自动 `invalidateQueries(['comics'])`+facets+libraries。

UI 是搜索框下方的一条品牌色薄条（`done/total` + 2px 进度线 + 「查看」直达漫画库），
空库时把「还没有漫画」换成「正在扫描漫画库」。

配色只让图标和进度条吃品牌色，文字走 `ink` 阶：`brand-300/400` 在浅色主题下是
「浅橙压浅橙」，实测读不清；`ink` 阶是反相映射的，深浅两套都稳。

## 5. PWA

- `public/manifest.webmanifest`：standalone、`start_url`/`scope=/`、192+512 图标
- `public/pwa-192.png` / `pwa-512.png`：由 `logo.png` LANCZOS 缩放（源图只有 192，
  512 是放大，启动器实机按 48–96dp 渲染，看不出软化）
- `public/sw.js`：`/api/*` **完全不拦截**；导航 network-first（断网回落缓存的
  `index.html`）；`/assets/*` cache-first（文件名带指纹）；其余 SWR；
  静态缓存上限 80 条，超限从最老删（旧指纹文件不会无限堆积）
- 服务端把 `.webmanifest` 注册成 `application/manifest+json`（Go 内建表里没有，
  Windows 还会先查注册表，缺了会退化成 `text/plain` 让部分浏览器忽略整个清单），
  `sw.js` 与 `index.html` 都是 `no-cache`

⚠️ SW 只在安全上下文注册（https / localhost / 127.0.0.1）。NAS 的
`http://192.168.x.x` 拿不到 SW 能力，这是浏览器限制；那里退化为普通网页，
manifest（添加到主屏）仍然有效。

## 实测结果

Slow-4G（390×844，夹具 512 本）：

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏列表请求 | 58,517B | 2,281B |
| 首张卡片可见 | 2366ms | **1820ms** |
| LCP | 2740ms | **2244ms** |
| FCP | 712ms | 772ms（首包多几十字节 manifest 链接，噪声级） |
| 首屏封面请求数 | 全部 120 张排队 | 3 张（懒加载 + 只 eager 前 6 张） |

不限速：首卡 327ms → 317ms，LCP 884ms → 824ms。

## 刻意没做

- **`maxPages` 截断页数**：会丢掉已经滚过去的顶部内容，回滚时卡片凭空消失。
  代价是「读很深再退回首页」时刷新会按页数发请求（每页 2KB 级，可接受）。
- **把 API 塞进 SW 缓存**：进度/收藏不能有第二份真相，排查「刚改完却看到旧值」的成本太高。
- **maskable 图标**：源图圆角内自带渐变，补边会出现可见接缝，宁可不声明 maskable。
- **漫画页加 ETag**（已论证过）：URL 不随内容
  变化，重扫后同名文件会被缓存成旧图。

## 验收

```bash
cd app/server-go && go test ./... && go vet ./...     # 含 compress_test.go 7 例
cd app/web && npm run typecheck && npm run build
node tools/pagination_check.mjs      # 15/15
node tools/scan_banner_check.mjs     # 6/6（[--theme=dark] 可出深色截图）
node tools/pwa_check.mjs             # 14/14（必须打生产实例 :13800）
node tools/contract_check.mjs        # 0 漂移（本轮 91 字段；字段数随契约增长，现值见 tools/README）
```

`pagination_check` 与 `scan_banner_check` 默认打 Vite（:5173），也可 `--base=` 指到生产实例。
