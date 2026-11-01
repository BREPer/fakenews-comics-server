# tools —— 开发期脚本

这里的脚本**不进运行时**，只在开发与验收时手动跑。除了 `precompress.mjs`（`npm run build`
会自动调用）外，任何脚本都不参与产品构建。

共同前置：Node ≥ 22；需要连后端的脚本默认打 `http://127.0.0.1:13800`（可用第一个参数覆盖）。
大部分 UI 类脚本通过 CDP 驱动 Edge，Edge 路径可用环境变量 `EDGE` 覆盖。

## 回归与契约

| 脚本 | 作用 |
|---|---|
| `regression_go.mjs` | 一键回归：交叉编译 → 起服务 → 7 个套件、567 条断言 |
| `regression.mjs` | 同一批断言的纯黑盒版，打一个已在跑的实例（`node tools/regression.mjs <baseUrl>`） |
| `contract_check.mjs` | 前后端字段契约比对（TS 类型 ↔ Go 响应），102 字段零漂移 |
| `api_fuzz.mjs` | 参数/边界/越权 fuzz，校验错误码与信封一致性 |
| `auth_flow_check.py` | 单账号门禁：登录、限流、Cookie、退出 |
| `e2e_live.mjs` | 实机功能测试：真浏览器走完整用户旅程 + 重启持久化 + 只读库反证 |
| `journey_test.mjs` | 用户旅程冒烟（比 `e2e_live` 轻） |

## 造数据

| 脚本 | 作用 |
|---|---|
| `make_test_data.py` | 造一批 cbz/zip/文件夹漫画（默认落 `.dev-comics`） |
| `make_bulk_data.mjs` | 大批量夹具（性能/分页用） |
| `make_chapter_fixtures.py` / `make_edge_data.py` | 章节型库与边界样本（空页、坏包、超长名） |
| `make_pdf.mjs` / `make_scan_pdf.mjs` / `make_pdf_test_lib.mjs` | PDF 样本：矢量页 / 扫描图 / 混排 |
| `make_upload_fixture.py` | 上传接口用的 zip 夹具 |
| `perf_fixture.mjs` | 性能场景夹具（大图、深目录） |

## 性能

| 脚本 | 作用 |
|---|---|
| `bench.mjs` | 接口串行 p50/p95 + 固定并发 QPS |
| `mem_probe_go.mjs` | 内存压测：父进程按间隔读 RSS，覆盖冷/热缓存与翻页 |
| `perf_audit.mjs` | 慢网体检（390×844 + Slow-4G），输出首屏指标 |
| `perf_reader.mjs` / `perf_boundary.mjs` | 阅读器渲染耗时、缓存边界 |
| `stress_check.mjs` | 并发与长连接压力 |

## UI / 适配

| 脚本 | 作用 |
|---|---|
| `responsive_check.mjs` | 多档视口扫描，判越界与最小宽度（判据用 `documentElement.clientWidth`） |
| `viewport_probe.mjs` | 视口几何探测 |
| `resp_dump.mjs` | 单页细查：列出小控件及其类名/命中归属（`--route`、`--w/--h`） |
| `layout_shift_check.mjs` | SPA 切页采 CLS + 定位肇事元素 |
| `nav_shift_probe.mjs` | 切页逐帧 scrollY/宽度 + 后退恢复 |
| `scroll_leak_check.mjs` | 弹层滚动锁与背景滚动泄漏 |
| `ui_shot.mjs` / `ui_shot2.mjs` | 批量出图（深/浅 × 各页面 × 移动端） |
| `accent_shot.mjs` / `detail_shot.mjs` / `drawer_shot.mjs` / `about_shot.mjs` | 定点出图核对（高亮色 / 详情页 / 章节抽屉 / 关于页） |

## 功能点校验（`*_check.mjs`）

按功能命名，一条命令跑一个关注点，例如 `pagination_check.mjs`（无限滚动）、
`pwa_check.mjs`（清单/SW/离线外壳）、`reader_resume_check.mjs`（续读位置）、
`split_check.mjs`（拆分双页）、`sheet_*_check.mjs`（弹层动画/层级/表面）、
`progress_*_check.mjs`（进度记录顺序）、`search_flash_check.mjs`（首屏闪烁）。
写完新功能按同样命名补一个，断言数写在文件头注释里。

## 其他

| 脚本 | 作用 |
|---|---|
| `precompress.mjs` | 生成 `.gz` 兄弟文件（`npm run build` 调用，**勿删**） |
| `gen_icons.py` / `logo_rebuild.py` / `logo_source.png` | 图标母版 → fpk / PWA / 网页全套 |
| `source_resolution_survey.py` | 统计真实漫画库里各格式/命名规则的分布 |
| `lib/` | 脚本共用模块：`image.mjs`（零依赖 PNG 读写）、`prefs.mjs`（注入 localStorage 偏好）、`py.mjs`（调用本机 python） |
