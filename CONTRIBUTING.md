# 贡献指南（CONTRIBUTING）

## 项目结构

```
app/server-go/                      Go 后端（唯一后端，无 CGO，PDF 走 WASM PDFium）
app/web/                            前端（Vite + React 18 + TS + TanStack Query + Tailwind）
manifest / cmd / config / wizard    fnOS fpk 包描述与生命周期脚本
build.ps1 / build.sh                fpk 打包脚本（交叉编译 + staging + fnpack）
tools/                              测试与诊断脚本
```

## 开发环境

- Go ≥ 1.26（见 `app/server-go/go.mod`）、Node ≥ 22
- 没有漫画也能跑，只是书架是空的；想先有内容：

```bash
python tools/make_test_data.py      # 造 8 部测试漫画到 %TEMP%/fakenews-comics
```

**最快的方式**是一键脚本（自动装依赖、构建前端、编后端、等健康检查，再起 vite）：

```bash
./dev.sh                            # 后端 127.0.0.1:13800 + 前端 127.0.0.1:5173
```

Windows 用 PowerShell 版本：`dev.ps1 -ComicRoot "$env:TEMP\fakenews-comics"`。

**手动起**（想自己接 dev server 时）：

```bash
# 后端：默认值是容器路径，本机跑必须显式给全这四个变量
cd app/server-go
APP_PORT=13800 COMIC_ROOT="$TEMP/fakenews-comics" DATA_DIR=./.dev-data WEB_DIST=../web/dist go run .

# 前端（另开终端；vite 已把 /api 代理到 13800）
cd app/web && npm install && npm run dev -- --host 127.0.0.1
```

> PowerShell 里环境变量写法不同：
> `$env:APP_PORT=13800; $env:COMIC_ROOT="$env:TEMP\fakenews-comics"; $env:DATA_DIR="./.dev-data"; $env:WEB_DIST="../web/dist"; go run .`
>
> `--host 127.0.0.1` 不能省：Vite 5 的 `localhost` 只绑 IPv6。

## 提交前检查

```bash
cd app/web && npm install && npm run typecheck && npm run build
cd app/server-go && go test ./... && go vet ./...
```

这几条 CI 也会跑（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）：Go 侧 build / vet / test，
Web 侧 `npm ci` + typecheck + build。PR 上红灯先本地复现，别靠重跑。

**测试都在哪**

| 类型 | 位置 | 怎么跑 |
|---|---|---|
| Go 单元测试（32 个文件） | `app/server-go/internal/**/*_test.go` | `go test ./...` |
| 契约 / 端到端 / UI 断言 | `tools/*.mjs`（打真实 HTTP，UI 类走 CDP 驱动浏览器） | 见 [`tools/README.md`](tools/README.md) |
| 前端单元测试 | 无 | 组件逻辑薄，靠上面两类覆盖 |

改动跨前后端时（比如加字段），跑一次 `node tools/contract_check.mjs` 能立刻看出契约漂移。

## 代码约定

1. **API 契约**：响应统一 `{code, data}` / `{code, message}`；错误码与字段名是对外契约，改动要同步前端。
2. **偏好按设备存**：`readerMode / readDir / fitMode / quality / preloadCount / pageAnimation / keepScreenOn / pinchZoom / theme / accent`
   十项以 `localStorage`（`app/web/src/utils/devicePrefs.ts`）为唯一真源；`PUT /api/settings` 对它们静默忽略。
3. **列表一律无限滚动**：`useInfiniteQuery`，`LIST_PAGE_SIZE = 36`，query key 前缀必须是 `['comics']`。
4. **弹层只用 `Sheet` / `ConfirmDialog`**，不要手写 `fixed inset-0`（滚动锁、焦点、Esc 都是内置的）。
5. **动画用 transform / opacity**，不要用 `left` / `width` 触发布局；遵循 `prefers-reduced-motion`。
6. **改 Go 后必须重启进程**：服务不做热重载。用 `go run .` 就重跑一次；用 `dev.sh` 它每次启动都会重编。
   如果你是手动 `go build` 到 `app/server-go/bin/` 再跑，改完记得重编，否则跑的是旧二进制。
7. **PDFium 是 WASM（wazero），不是 CGO**：WASM 实例池上限 2，按操作「借 → 开 → 渲染 → 还」，不要长期持有。

## 许可证

本项目以 [GNU General Public License v3.0](LICENSE)（GPL-3.0）发布。
