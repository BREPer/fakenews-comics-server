# 肥牛漫画（fakenews-comics）

[![CI](https://github.com/BREPer/fakenews-comics-server/actions/workflows/ci.yml/badge.svg)](https://github.com/BREPer/fakenews-comics-server/actions/workflows/ci.yml)

飞牛 fnOS 上的自托管漫画阅读器：把 NAS 里的漫画目录交给它，就得到一个多端可用的在线书架——
封面墙、筛选、搜索、四种翻页模式、阅读进度记忆。全部读本地文件，不下载、不联网刮削。

以 **fpk** 形式分发——fnOS 的应用安装包（类似 deb / apk），在应用中心手动安装即可，不需要命令行。

**可直接阅读**：cbz / cbr / zip / rar / tar / cbt / pdf / epub，以及散图目录。
`7z` / `cb7` / `mobi` 只会被扫描入库，暂不支持解析（打开返回 415、页数为 0）。

**想做什么**

| 目的 | 入口 |
|---|---|
| 3 分钟在本机看到界面 | [快速开始](#快速开始) |
| 装到飞牛 NAS | [打包 fpk](#打包-fpk) → [安装](#安装到飞牛-nas) |
| 参与开发 | [CONTRIBUTING.md](CONTRIBUTING.md) · [项目结构](docs/项目结构.md) |
| 看设计与数据模型 | [docs/实现方案.md](docs/实现方案.md) |
| 查接口与错误码 | [API 一览](#api-一览) · [错误码约定](#错误码约定) |
| Android 客户端 | [fakenews-comics-android](https://github.com/BREPer/fakenews-comics-android) |

## 目录

- **上手**：[快速开始](#快速开始) · [开发](#开发) · [打包 fpk](#打包-fpk) · [安装到飞牛 NAS](#安装到飞牛-nas) · [文件夹访问权限](#文件夹访问权限重要)
- **概念与约定**：[目录结构](#目录结构) · [目录约定](#目录约定扫描器规则) · [数据与缓存](#数据与缓存) · [版本号](#版本号) · [阅读进度模型](#阅读进度模型) · [已知边界](#已知边界)
- **实现与接口**：[性能与实现要点](#性能与实现要点) · [前端约定](#前端约定) · [错误码约定](#错误码约定) · [API 一览](#api-一览) · [阅读器交互](#阅读器交互) · [登录保护](#登录保护单账号门禁)
- **其他**：[文档地图](#文档地图) · [安装问题排查](#安装问题排查) · [许可证](#许可证)

## 快速开始

前置：Go ≥ 1.26（版本见 `app/server-go/go.mod`）、Node ≥ 22。

```bash
python tools/make_test_data.py                    # 造 8 部测试漫画到 %TEMP%/fakenews-comics
COMIC_ROOT="$TEMP/fakenews-comics" ./dev.sh       # 换成自己的目录也可以
```

脚本会自动装前端依赖、构建 dist、编后端、等健康检查，最后起 vite：

- 界面（dev，热更新）：<http://127.0.0.1:5173>
- 接口健康检查：<http://127.0.0.1:13800/api/health>

没有漫画也能起，只是书架是空的。想换成自己的库就改 `COMIC_ROOT`。

Windows 用 PowerShell 版本，效果一样：

```powershell
.\dev.ps1 -ComicRoot "$env:TEMP\fakenews-comics"
```

## 目录结构

只列主干，完整目录树和「按任务找文件」的速查表见 [docs/项目结构.md](docs/项目结构.md)。

```
fakenews-comics/
├── manifest / ICON*.PNG / cmd / config / wizard   fpk 外壳：身份信息、生命周期、安装向导
├── app/
│   ├── server-go/       后端（Go，唯一进程）：路由 + 扫描 + 缩略图 + 静态伺服
│   ├── web/             前端（Vite + React + TS）
│   ├── docker/          单容器 compose
│   └── ui/              fnOS 桌面入口
├── tools/               开发期脚本：回归 / 造数据 / 出图 / 性能
├── docs/                设计与专题文档
└── build.* / dev.*      打包与本地开发脚本
```

## 文档地图

| 文档 | 讲什么 | 什么时候看 |
|---|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、提交前检查、7 条代码约定 | **动手改代码前** |
| [docs/项目结构.md](docs/项目结构.md) | 完整目录树 + 「按任务找文件」速查 | 找东西在哪 |
| [docs/实现方案.md](docs/实现方案.md) | 信息架构、数据模型、API 契约、页面布局 | 改功能前对齐设计 |
| [docs/2026-10-23-上传按库类型改造.md](docs/2026-10-23-上传按库类型改造.md) | 上传按「章节型 / 单篇型」分流（解压与否） | 动上传逻辑前 |
| [docs/2026-10-23-前端视觉与慢网优化.md](docs/2026-10-23-前端视觉与慢网优化.md) | 视觉细节与弱网下的取舍 | 调样式 / 首屏 |
| [docs/2026-10-25-交互反馈与失败态.md](docs/2026-10-25-交互反馈与失败态.md) | 轻提示与撤销、弹层键盘、失败态文案 | 加交互反馈 |
| [docs/2026-10-25-可感知优化-压缩分页PWA.md](docs/2026-10-25-可感知优化-压缩分页PWA.md) | 压缩 / ETag / 分页 / 扫描提示 / PWA 的实测结论 | 动接口或首屏性能 |
| [tools/README.md](tools/README.md) | 开发期脚本分类与前置 | 跑测试 / 造数据 |

## 开发

想自己接前端 dev server（不跑 `dev.sh`）就手动起：

```bash
# 1) 后端。注意：**不显式给变量时用的是容器默认值**（端口 3000、库 /comics、
#    DATA_DIR=/data、SPA 关闭）——浏览器打开会 404，Windows 上还会在 C:\data 建库。
cd app/server-go
APP_PORT=13800 COMIC_ROOT="$TEMP/fakenews-comics" DATA_DIR=./.dev-data WEB_DIST=../web/dist go run .

# 2) 前端（另开终端）。必须带 --host 127.0.0.1：Vite 5 的 localhost 只绑 IPv6
cd app/web && npm install && npm run dev -- --host 127.0.0.1

# 单元测试（源层 / 扫描器 / 图像 / PDF）
cd app/server-go && go test ./internal/... -v
```

go 不在 PATH 上时：`. ./goenv.sh` 之后用 `$GO` 代替 `go`。版本要求见 `app/server-go/go.mod`。

本地联调：`app/web/vite.config.ts` 已将 `/api` 代理到 `http://127.0.0.1:13800`。

**回归套件打的是 HTTP 契约**：

```bash
node tools/regression_go.mjs    # 交叉编译 → 起 Go 服务 → 7 套件 567 断言
```

改契约时同步更新这里的断言数（当前 567 条）。

另有一套**实机功能测试**（真浏览器走完整用户旅程 + 重启持久化 + 只读库反证），37 条断言：

```bash
node tools/e2e_live.mjs          # 需要 Edge；--no-browser 可跳过浏览器段
```

它与回归套件的分工：回归守**契约**（字段/状态码/组件行为），实机守**用户旅程**
（首次打开 → 翻书 → 收藏 → 重启后还在）。

**依赖说明**（`third_party/go-pdfium` 是 vendored 模块）：

- PDFium 走 WASM（`webassembly.Init`，wazero 运行时），**不是** CGO 后端——本机无 gcc 也能构建、可交叉编译
- PDF 文档用 `OpenDocument{FileReader: io.ReadSeeker}` 打开：WASM 里看不到 Windows 卷标，且惰性读取不全量载入
- **WASM 实例是有限资源**：池上限 2 个，`PdfSource` 按操作「借实例→开文档→渲染→关文档→还实例」，
  绝不长期持有。早期实现让每个源独占实例，源缓存一多就 `Timeout waiting for idle object`（已修）

## 打包 fpk

前置：Node ≥ 22 + Go。两个脚本都会自动 `npm install` 并构建前端，不必先手动 build。

```powershell
.\build.ps1                    # Windows；加 -SkipWebBuild 复用已有 dist
```

```bash
./build.sh                     # Linux / macOS / NAS SSH；加 SKIP_WEB=1 复用已有 dist
```

打包做了四步：

| 步骤 | 做了什么 |
|---|---|
| 1. 前端 | 缺 `node_modules` 时 `npm install` → `npm run build` → `app/web/dist` |
| 2. 后端 | 交叉编译 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64`；版本号从 `manifest` 读出，用 `-ldflags` 注进 `version.AppVersion` |
| 3. 组装 | 收拢到 `.build/fpk`：`manifest` / `cmd` / `config` / `wizard` / `app/ui` / `app/docker` + Dockerfile + 二进制 + `web-dist` |
| 4. 打包 | 首次自动下载 fnpack 1.2.3 到 `.toolchain/` → 产出 `fakenews-comics-<version>.fpk`（约 10MB，**不含镜像**） |

产物名**必须带版本号**：多版本并存不互相覆盖，NAS 上也能一眼看出装的是哪版。

**镜像是现场构建的**：`docker-compose.yaml` 含 `build:`，安装后由应用中心 `compose up` 构建。
但内容只是「两次 COPY」（二进制 + 前端 dist），`FROM scratch`、零联网、1~2 秒完成。
想彻底免构建就改成离线镜像：打包机 `docker build` + `docker save`，compose 去掉 `build:`。

**ARM 机器**：`GOARCH_TARGET=arm64 ./build.sh`（Windows 上改脚本里的 `GOARCH`），同时把
`manifest` 的 `platform` 改 `arm`、Dockerfile 的 `COPY` 路径换成 arm64 产物名。
镜像本身不用换基础镜像——`FROM scratch` + 静态二进制，架构跟着二进制走。

**出包前必须升版本**：`manifest` 的 `version` 加一档（如 2.1.0 → 2.1.1），
否则应用中心会按「同版本」拒绝升级。

## 安装到飞牛 NAS

> 本仓库**不提供预编译包**，先按上一节打包出 `fakenews-comics-<version>.fpk`。

1. 应用中心 → 手动安装 → 选择 `fakenews-comics-<version>.fpk`
2. 向导填写：Web 端口（默认 2233）、漫画根目录（如 `/vol1/1000/comics`）
3. 安装后应用中心会自动 `docker compose up -d` **现场构建镜像**：镜像内容只有二进制 + 前端产物
   （`FROM scratch`、无基础镜像、不联网），通常几秒完成；较慢的机器上给它跑完，别中途卸载。
   首次启动自动创建默认库「我的漫画」并执行全量扫描
4. 桌面入口「肥牛漫画」或浏览器 `http://<NAS IP>:2233`
5. **书架是空的？** 大概率是没授权目录，见下一节

也可 SSH 安装：`appcenter-cli install-fpk /path/to/fakenews-comics-<version>.fpk`

## 文件夹访问权限（重要）

fnOS 的安全模型：**应用默认无权访问用户文件，必须显式授权**。安装后如果书架是空的或提示无法读取目录，按以下两步处理：

1. **授权目录给应用**（manifest 已声明 `disable_authorization_path = false`，设置页才有此入口）：
   fnOS「设置 → 应用 → 肥牛漫画 → 文件夹访问权限」→ 添加安装向导里填写的同一个漫画目录（只读即可）。
   授权的路径会通过环境变量 `TRIM_DATA_ACCESSIBLE_PATHS` 提供给应用。
2. **确认目录允许 Docker 访问**：如果漫画目录是你在文件管理里新建的共享文件夹，右键 → 属性/编辑 →
   勾选「允许 Docker 容器访问」（不勾选则 Docker 无法挂载该目录）。

> 说明：fnOS 向导（wizard）只有 7 种条目类型（text/password/radio/checkbox/select/switch/tips），
> 没有文件夹选择器，因此路径只能在安装向导用文本填写、装后再在设置页授权——
> 这是 fnOS 的既定设计，不是遗漏。

**验证授权是否生效**（SSH）：

```bash
docker exec fakenews-comics ls -la /comics      # 应能看到漫画目录内容
docker inspect fakenews-comics --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

## 目录约定（扫描器规则）

**根部的一个子目录 = 一部漫画**，漫画内部的「章」按形态区分：

| 形态 | 章节怎么切 | 备注 |
|---|---|---|
| 文件夹型<br>`阿飞正传/第01卷/001.jpg` | 每个子文件夹 = 一章 | 最常见 |
| 混合结构<br>目录里既有散图又有章子目录 | 顶层散图单独成一章（排首位，标题取漫画名），章子目录依次在后 | 散图章只含顶层图片，不会把子目录的页混进来 |
| cbz / zip / tar / cbt | 包内一级目录 = 一章；图片平铺在包根则整包一章 | `.tar/.cbt` 用标准库 `archive/tar`，零第三方依赖 |
| rar / cbr | 同上 | 用纯 Go 的 `rardecode`（vendor 在 `third_party/rardecode`），支持 RAR3/RAR5 与固实归档；**固实包只能顺序读，翻到后面会明显变慢**，这是格式本身的代价 |
| EPUB | 整本一章，页序以 OPF 的 **spine** 为准（不是文件名排序） | 元数据取 `dc:` 字段；纯文本无图页会被忽略 |
| 无子目录的散图文件夹 | 整册一章（递归取图，兼容 `漫画/images/001.jpg`） | — |

其余规则：

- 章 / 页都走**自然排序**：`第2章` 早于 `第10章`，`02.png` 早于 `10.png`
- `sample*` / `preview*` / `thumbnail*` 命名的图片视为推广样张，**自动跳过**（不进页列表、不单独成章）
- 隐藏目录（`.` / `@` / `__MACOSX` 开头）跳过
- 漫画目录以**只读**挂载到 `/comics`，应用不改原文件
- 新增内容后到「设置 → 重新扫描」触发增量扫描（以 `comics.path` 为比对键）

### 元数据刮削（ComicInfo.xml）

压缩包内或文件夹下的 `ComicInfo.xml`（通用漫画元数据格式，大小写不敏感）
会被自动读取，用于补全：

| ComicInfo 字段 | 落库字段 | 说明 |
|---|---|---|
| `Series` + `Title` | 标题 | 两者都有时组合为 `Series - Title`（Title 已含 Series 则不重复） |
| `Writer` | 作者 | 无则由文件名猜测 |
| `Summary` | 简介 | 支持 CDATA 与 XML 实体 |
| `Genre` / `Tags` | 标签 | 按 `,;，；` 拆分，与格式、库名合并去重，可用于筛选 |

**用户编辑优先**：一旦在应用内改过标题/作者/简介，`meta_locked` 置 1，之后重扫与刮削都不会覆盖。

## 数据与缓存

| 位置 | 内容 |
|---|---|
| `${TRIM_PKGVAR}/data/db/fakenews-comics.db` | SQLite：库/漫画/章索引、进度、收藏、设置 |
| `${TRIM_PKGVAR}/data/cache/thumbs/` | 缩略图 WebP（按宽分档） |
| `${TRIM_PKGVAR}/data/cache/covers/` | 自动封面（章0页0） |
| `${TRIM_PKGVAR}/data/cache/covers-custom/` | 自定义封面（长按设封面 / 上传） |

`TRIM_*` 是 fnOS 注入的路径变量：`TRIM_PKGVAR` 是**应用数据目录**（卸载时按向导决定是否保留），
`TRIM_APPDEST` 是应用安装目录。本地开发时用环境变量 `DATA_DIR` 代替。

**缓存治理**

- 上限在设置页「缓存上限」调（默认 2048MB；部署默认值 `THUMB_CACHE_MB`）
- 每次写盘记账，超限时按 mtime 最旧优先淘汰到 85%，并始终保留最新 8 个（避免删掉正在读的页）
- 内存层另有 256 条 LRU；设置页可看实际用量 / 一键清理 / 调上限（改小立即回收）
- 备份**不含**缓存，删掉会自动重建

**自动扫描**：设置页「自动扫描间隔」选 6h / 24h 后，服务端按间隔触发增量扫描；改动即时生效，不用重启。

**增量扫描**

- 比对键是 `file_modified_at`（mtime）：没变的条目直接跳过，不重解析元数据与页数
- `POST /api/scan {"full":true}` 强制全量重解析（换了命名/解析规则，或想重刷刮削结果时用）
- 解析规则版本记在 `settings.scanMetaVersion`；版本升级后首轮自动全量，老库升级不用手动操作
- 扫描状态接口返回 `skipped`（本轮跳过数）、`fullParse`（是否全量）、`skippedLibs`（根目录不可访问而跳过的库）

**数据安全保护**

- 库根目录不可访问时（卷没挂载、网络盘断连），该库**整库跳过**，绝不当作「全部已删除」去清理
- 只有位于可访问根之下、且确实消失的条目才会被移除，并级联清理它的进度、分章标记与收藏
- 删除整个库时同样清理全部关联数据

**数据备份**：设置页「数据备份」可把进度、分章已读、收藏、设置导出为 JSON，也可合并导入
（导入不删除本地数据，只接受本机已存在的漫画——comicId 基于路径哈希，换机器同路径可复用；
旧时间戳不会覆盖较新的进度，分章百分比取较大值）。

卸载时可选保留（默认）或删除；升级前 `cmd/upgrade_init` 自动备份数据库（保留最近 3 份）。

## 版本号

打包版本的唯一真源是 `manifest` 的 `version`：`build.ps1` / `build.sh` 会读它并用
`-ldflags "-X fakenews-comics/internal/version.AppVersion=..."` 注入二进制，
**不会出现「manifest 升了但二进制里还是旧版本」**。

发版时仍需同步改这几处（其余靠注入）：

1. `app/server-go/internal/version/version.go` → `AppVersion`（开发默认值，`go run` 时生效）
2. `manifest` → `version`（fpk 包版本，`x.y.z`；**打包脚本以它为准**）
3. `app/web/package.json` → `version`（前端构建时由 `vite.config.ts` 注入为 `__APP_VERSION__`）

「关于」页会比对前后端版本：不一致说明安装包没完整更新（覆盖安装后记得强制刷新页面）。

## 阅读进度模型

- **全书进度**（`reading_progress`）：每部一条，记录当前章节/页码/百分比，供「继续阅读」与阅读记录
- **分章进度**（`chapter_progress`）：每章一条，用于详情页章节列表的「已读 / 阅读百分比」标记；
  到达该章最后一页即视为读完（100%），重读不会回退已读状态
- 文件被替换（mtime 变化）后重扫会**清空该漫画的分章标记**（章 id 基于序号，避免错位）
- 「重置进度」会同时清空全书进度与分章标记

## 已知边界

- **现场构建**：fpk 不含镜像，安装后由应用中心 `compose up` 现场构建（`FROM scratch`，
  只做两次 `COPY`，1~2 秒、零联网）。细节见 [打包 fpk](#打包-fpk)。
- 内置二进制面向 **linux-x64（glibc）**，与 manifest `platform = x86` 一致；
  ARM 架构 NAS 需交叉出包（`platform = arm` + linux-arm64 二进制）
- 压缩包支持 zip 系（cbz/zip）、rar/cbr、tar/cbt、pdf、epub；PDF 由 WASM PDFium 光栅化（整本单章）
- `7z` / `cb7` / `mobi` 只识别入库、不做解析（打开返回 415，阅读为 0 页）——补解码器才支持
- 漫画库类型 `single`（单篇）已在数据模型中，UI 默认 `chapter`
- **两层嵌套**（`漫画名/第01卷/第01话/*.png`）：`第01卷` 会被当成独立漫画。
  这是 promote 启发式的固有取舍——某目录下只有一层子目录时把子目录提成独立漫画，避免出现空壳漫画；
  一层 `漫画名/第01卷/*.png` 是正常形态
- **章子目录里再放压缩包**（`漫画/第01卷/第01话.cbz`）：该章按目录判页数为 0，包内内容不可达。
  打包文件请放在漫画目录**顶层**（那种情况会被识别为独立章节）

## 性能与实现要点

单机自托管场景下，热路径的取舍都落在「少一次 IO / 少一次编译 / 少一次重复渲染」上：

| 位置 | 做法 | 效果 |
|---|---|---|
| SQLite | `db.prepare()` 语句缓存（256 条 FIFO）+ `synchronous=NORMAL` + `temp_store=MEMORY` + 16MB 页缓存 | 热接口省掉每次的 SQL 编译；扫描期几百次 upsert 不再每次 fsync |
| 列表接口 | 进度/收藏/库类型**一次 JOIN** 取全（去掉逐行相关子查询），并加 `c.id` 兜底排序 | 分页排序稳定（同 `added_at` 不再跨页重复/漏项） |
| 名称排序 | `sort=title` 按 **ICU 中文排序**（`Intl.Collator('zh')`）：只取 `id,title` 两列排序后按页回取整行 | SQLite 无 ICU，默认字节序会把「阿飞」排到最后；现在与浏览器 `localeCompare('zh')` 完全一致 |
| facets | 题材/格式聚合结果整块缓存，扫描收尾、改标签、删库删书时显式失效 | 首页每次进入不再全表扫描 + 逐行 `JSON.parse` |
| 封面/缩略图 | 同一 key 的并发渲染合并（`withInFlight`），磁盘缓存 + 256 条内存 LRU | 首屏几十张封面并发时，同一本只渲染一次 |
| 详情章页数 | 逐章数页数受限并发（4）而非串行 | 20 章的漫画不再等 20 轮 IO |
| 静态资源 | 构建期用 `tools/precompress.mjs` 生成 `.gz` 兄弟文件，命中就直接下发；带指纹的产物 `immutable` 强缓存，`index.html` 为 `no-cache` | 首屏 JS 约 434KB → gzip 后 132KB，运行时不花 CPU 压缩；升级后不会卡在旧入口 |
| 前端 | 路由级 `React.lazy` 分包（阅读器/详情/设置各自成 chunk）+ `ComicCard` 按字段 `memo` | 首屏只加载「框架 + 首页 + 卡片」；进度刷新时只有变化的那几张卡重渲染 |

压测脚本：`node tools/bench.mjs [baseUrl]`（串行 p50/p95 + 固定并发 QPS）。

### 内存上限

Go 的 `image` 解码必须整张分配位图（24MP 页 = 96MB），所以峰值全靠「限并发 + 及时归还」控：

| 机制 | 默认 | 位置 |
|---|---|---|
| 解码/光栅化全局闸 | `IMG_CONCURRENCY=2` | `internal/gate` |
| 大图独占（>16MP 一次只解一张） | 内置 | `internal/gate` |
| 单图解码像素上限（超出 415） | `MAX_DECODE_MP=60` | `internal/images` |
| PDF 渲染倍率（相对 pt 点数） | `PDF_RENDER_SCALE=2` | `internal/sources` |
| PDF 原图页缓存 | 6 页 + `PDF_PAGE_CACHE_MB=64` | `internal/sources` |
| 缩略图内存层 | 真 LRU + `MEM_CACHE_MB=32` | `internal/images` |
| Go 软内存上限 | 容器 cgroup 上限 ×55%（`MEMORY_LIMIT_MB` 可覆盖） | `main.go` |
| RSS 归还 | 释放钩子 5s 防抖 + 空闲 3s 后台归还 | `internal/gate` |

实测（`tools/mem_probe_go.mjs`，12 部 4000×6000 巨扫库）：峰值 **3627MB → 620MB**，
且峰值后回落到 ~22MB。

> 别把「内存高」直接当成泄漏：容器 `memory.current` 含页缓存，页缓存不算进进程 RSS。


### 后端实现要点

| 能力 | 实现 |
|---|---|
| HTTP | stdlib `net/http`（1.22 方法 + 通配符路由），零框架；中间件仅 recover + 日志 |
| SQLite | `modernc.org/sqlite`（纯 Go，可交叉编译） |
| zip / cbz / epub | `archive/zip` + 手写 OPF spine；条目 Range 用「跳过 + LimitReader」 |
| 缩略图 | `x/image/draw` CatmullRom（JPEG q76/85），零原生依赖 |
| EXIF 方向 | 手写最小 EXIF 解析（8 向，只读 APP1 Orientation） |
| PDF 渲染 | **WASM PDFium**（`go-pdfium` + wazero），实例池上限 2，按操作借还 |
| 中文排序 | `x/text/collate`（zh），拼音主序 |
| 静态资源 | 手写 `ServeFile` + precompress 产物，`.gz` 兄弟文件存在则直出 |

## 前端约定

- **主题**：`ink` 色阶由 CSS 变量驱动（`index.css` 里 `:root` 浅色 / `.dark` 深色），
  组件里用 `bg-ink-900`、`text-ink-300` 等**自动跟随主题**；不要写死十六进制色值。
  切换在 `<html>` 上加/去 `dark` 类（`src/theme.ts`），选择存 localStorage 并在首帧应用，避免闪色；
  `system` 模式跟随系统明暗变化；覆盖在图片/遮罩上的文字用 `text-white` 而非 `text-ink-*`。
- **内部导航**一律用 react-router 的 `<Link>` / `useNavigate`，不要用 `<a href>`（会整页刷新）。
- **操作反馈**统一走 `components/ui/toast.tsx` 的 `toast.success/error/undo`：
  任何会改服务端状态的动作都要有成功或失败的回执；乐观更新且界面本身有明确反馈的开关可以只在失败时提示。
  可恢复的破坏性操作（如删除阅读记录）用 `toast.undo()` 给 6 秒撤销窗口，别直接删。
- **弹层**用 `components/ui` 的 `Sheet` / `ConfirmDialog`（已内置 Esc 关闭、焦点管理、`aria-modal`）；
  不要自己写 `fixed inset-0` 面板，否则层级与键盘行为都要重来一遍。
- 阅读器为固定黑底（漫画阅读习惯），不随主题变化。
- **响应式框架**（`components/layout/AppShell.tsx`）：≥1024px 侧边栏（图标+文字）｜640-1023px 图标 Rail｜<640px 底部 Tab。
  ⚠️ 根容器的 flex 断点是 **`sm` 不是 `lg`**：Rail 在 640-1023px 可见，若根容器停在 block，
  `sticky + h-dvh` 的侧栏会在文档流里占满一整屏高，把主区全部顶出首屏（平板竖屏打开只看到一列图标，2026-10-22 踩中修复）。
- **视口高度**用 `.min-h-dvh` / `.h-dvh` / `.max-h-sheet`（先 `100vh` 兜底再 `dvh` 覆盖）而非裸 `h-screen`：
  移动端浏览器地址栏伸缩时 `100vh` 大于可见区，会吞掉底部工具栏与弹出层。
- **触控**：`html` 设 `touch-action: manipulation`（去双击缩放与 300ms 延迟，保留双指）；阅读器另有 `body.reader-lock` 全锁。
  底部 Tab / Rail 图标的触控目标 ≥44px；横屏挖孔设备的安全区由 `env(safe-area-inset-*)` 兜（阅读器工具栏左右均已含）。
- 多设备视口回归：`node tools/viewport_probe.mjs [baseUrl]`（平板竖横屏/手机/手机横屏/桌面，79 项断言，已并入 `regression_go.mjs`）。

## 错误码约定

| 状态码 | 含义 |
|---|---|
| 400 | 参数缺失/类型不符（body/path 参数） |
| 404 | 漫画/章节/页不存在，或文件已消失 |
| 415 | 文件存在但无法解析（坏包、加密、格式不符） |
| 416 | Range 越界（带 `Content-Range: bytes */total`） |
| 500 | 未预期错误（响应体仍为 `{code,message}` 信封） |

其他约定：分页参数非法时**宽容归一**（`page=0` → 1、`pageSize` 超限截断 200）；
搜索词会剥掉控制字符并转义 LIKE 通配符（搜 `100%` 只匹配字面量）；
Range 语法非法时按 RFC 7233 **忽略 Range 返回 200**。


## API 一览

统一信封 `{ code: 0, data }`；`code !== 0` 为业务错误。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/comics` | 列表（q/library/status/format/tag/sort/order 分页） |
| GET | `/api/comics/facets` | 筛选面（格式/标签/状态计数） |
| GET | `/api/comics/:id` | 详情 + 章列表（含每章已读百分比 `percent` / `read`） |
| PUT | `/api/comics/:id` | 编辑元数据（编辑后重扫不覆盖） |
| POST | `/api/comics/:id/scan` | **单部重扫**（替换文件后局部刷新，不扫全库） |
| GET | `/api/comics/:id/cover?w=` | 封面（自定义优先） |
| POST | `/api/comics/:id/cover` | 上传自定义封面（multipart） |
| POST | `/api/comics/:id/cover-from-page` | 把某一页提成封面 |
| GET | `/api/comics/:cid/chapters/:ch/pages` | 章内页元信息 |
| GET | `/api/comics/:cid/chapters/:ch/pages/:i` | 单页图流（Range 206；`?quality=standard` 缩略图） |
| GET/PUT | `/api/progress` | 阅读进度（看封面不记录，实际翻页才记） |
| POST | `/api/progress/:id/reset` | 重置进度 |
| GET/POST/DELETE | `/api/favorites` | 收藏 |
| GET/DELETE | `/api/history` | 阅读记录 |
| GET/POST/PATCH/DELETE | `/api/libraries` | 漫画库 CRUD |
| POST | `/api/libraries/reorder` | 库排序 |
| GET/POST | `/api/scan` | 扫描状态 / 触发扫描（默认增量：mtime 未变跳过；`{full:true}` 强制全量重解析） |
| GET/PUT | `/api/settings` | 阅读设置（服务端持久化） |
| GET | `/api/cache/stats` | 缓存用量（总量/上限/文件数/分类占用） |
| POST | `/api/cache/clear` | 清空缩略图与封面缓存 |
| POST | `/api/cache/evict` | 按当前上限立即淘汰一次 |
| GET | `/api/backup/export` | 导出阅读数据（进度/分章/收藏/设置 → JSON） |
| POST | `/api/backup/import` | 合并导入阅读数据（只接受本机已有漫画） |
| GET | `/api/about` | 运行信息（版本/构建时间/Node/平台/路径/数据库大小），设置页「关于」用 |
| GET | `/api/health` | 存活检查（含 `name`/`version`，可用于确认 NAS 上跑的是哪个版本） |
| GET | `/api/auth/status` | **公开**：登录是否启用 / 当前是否已登录（登录页与守卫用） |
| POST | `/api/auth/login` | 登录（用户名+密码 → HttpOnly 会话 Cookie） |
| POST | `/api/auth/logout` | 退出登录 |
| PUT | `/api/auth/credentials` | 设置/修改用户名密码（≥6 位；改后踢掉其它会话） |
| PUT | `/api/auth/enabled` | 开/关登录保护（无凭据时拒绝开启，避免把自己锁外面） |

### 响应编码与缓存

`/api/*` 的 JSON 响应统一走一层 `httputil.Compress`（`app/server-go/internal/httputil/compress.go`）：

- **gzip**：仅 JSON / `text/*`、状态 200、且响应体 ≥1KB 才压。实测首屏列表
  `GET /api/comics?pageSize=36` 18,124B → 2,281B（-87%）；`/api/history?limit=100` -90%。
- **弱 ETag + `Cache-Control: no-cache`**：浏览器存下来但每次回源验证，命中 `If-None-Match`
  直接 304。ETag 带 `-gz` 后缀区分 gzip / identity 两种表示，避免串包。
- **不压的**：图片（封面 / 页面流本身已压缩）、`206` 与带 `Content-Range` 的响应、
  已有 `Content-Encoding` 的预压缩静态文件。写请求（PUT/POST）不加校验器。
- 静态资源仍是构建期预压缩的 `.gz` + `immutable`（见 `tools/precompress.mjs`），
  `sw.js` 与 `index.html` 例外，两者都是 `no-cache`。

### PWA / 离线外壳

`app/web/public/manifest.webmanifest` + `sw.js`：安装到主屏后独立窗口打开，
二次访问由 Service Worker 接管——`/assets/*`（文件名带内容指纹）cache-first，
导航请求 network-first（断网回落到缓存的 `index.html`），**`/api/*` 完全不拦截**
（进度/收藏不能有第二份真相）。

⚠️ Service Worker 只在**安全上下文**（https / localhost / 127.0.0.1）注册；
NAS 上常见的 `http://192.168.x.x` 拿不到 SW 能力（浏览器平台限制），
那里退化为普通网页，manifest（添加到主屏）仍然有效。验证：`node tools/pwa_check.mjs`。

## 阅读器交互

- 单页/双页/拆分/卷轴四种模式；两侧点击区翻页、键盘 ←→↑↓、音量键（可配）
- **翻页动画四选一**：平移（默认）/ 轻移 / 淡入 / 无
- **「平移」是胶片式轨道**（1:1 跟手，松手按速度与位移吸附）：左右相邻页常驻在同一条 300% 宽的轨道上，
  翻页只移动轨道本身 ——
  - 点击/键盘：整页位移 260ms，缓动 ≈ easeOutQuad（起步利落、收尾不拖）
  - 拖动：跟手 1:1，松手按「位移 >18% 页宽」**或**「甩动 >0.35px/ms」吸附到相邻页，否则弹回
  - 首/末页边缘有 0.3 阻尼（橡皮筋），不会拖出空白
  - 轨道槽位按**页号**做 key，翻页时图片节点被复用 → 不会重建、不会重新淡入（否则滑出中的旧页会半透明）
- **章末续翻自动进入下一章**；章首往前翻回到上一章最后一页（均带轻提示）
- **整部漫画的首/末页再往外翻**：显示「已经是第一页了 / 已经是最后一页了」并让画面朝翻页方向回弹（橡皮筋效果）
- **章节目录四格**：**详情页**章节区右上角可切「列表 / 一行四格」（方形格子、当前章高亮、已读打勾、在读用底部细条），
  点格子直接进那一章；选择记在本机（`fakenews:detailChapterView`）。阅读器内的章节抽屉同样支持列表/四格（`fakenews:chapterView`）
- **画质三档**：流畅（720 宽）/ 标准（1080 宽）/ 原图（原字节 Range）；前两档走缩略图缓存，原图支持断点续传
- **双指缩放**（可开关，默认关闭）：两指 1–4 倍缩放、锚点跟随手势；放大后单指拖动查看，单击只显隐工具栏，换页自动复位
- 单击中部显隐工具栏，3 秒无操作自动隐藏（阅读器内不提供「长按设封面」，避免误触发）

> **翻页模式按浏览器记忆**：阅读器内切换只写 localStorage（`fakenews:readerMode`），不覆盖服务端全局设置，
> 这样平板用双页、手机用卷轴不会互相打架；本机没有记录时才用服务端设置。

## 登录保护（单账号门禁）

设置页 →「登录保护」。**默认关闭**（升级不打断现有用户），开启后：

- **只拦 `/api/*`**，静态资源与 SPA 放行——否则登录页自己都加载不出来
- 豁免 `/api/health`（容器健康检查要用）与 `/api/auth/*`（登录本身）
- 未登录访问页面 → 自动跳 `/login` 并记住来路；会话过期时任何接口的 401 都触发同一跳转
- 单账号：**进度/收藏/书架仍是全库共享**，不做 per-user 隔离

安全细节：

| 项 | 做法 |
|---|---|
| 口令存储 | PBKDF2-HMAC-SHA256，210k 次迭代 + 16 字节随机盐（stdlib `crypto/pbkdf2`，**不引第三方依赖**） |
| 会话 | 32 字节随机 token；DB 只存 SHA-256 散列，库被拷走也无法直接冒用 |
| Cookie | `HttpOnly` + `SameSite=Lax` + `Max-Age=30d`；`Secure` 仅在 https 下加（NAS 多为 http，强制会让登录不可用） |
| 暴力破解 | 同一 IP 连错 10 次锁 5 分钟（返回 429） |
| 口令强度 | 6–256 位；用户名 1–64 字 |
| 泄漏面 | `GET /api/settings` **不含** `authPassHash` / `authSalt` / `authUser`（内部键过滤） |

> 前端对这批接口按「未启用」静默降级（不报错、不挡人）：装上旧版二进制时不至于白屏。

## 安装问题排查

**本版现场构建（无内置镜像）**：fpk 内 `app/server-go` 只含 Dockerfile + 预编译二进制 + web-dist，
应用中心安装后 `compose up` 时 `docker build` 现场生成镜像。若安装长时间停在「构建中」属正常，
请耐心等待；若最终报错失败，常见原因如下：

1. **磁盘空间不足**：镜像约 30MB，空间不足会 build 失败。SSH 执行 `df -h` 确认安装卷余量。
2. **卸载卡死兜底**：若异常 compose 状态导致卸载卡死，可 SSH 执行 `systemctl restart dockermgr.service` 后重试
   （社区已知 fnOS docker 模块问题）。本应用卸载流程已做容错（卸载前显式 `docker compose down -v`、
   未声明 home 用途时不再因 `TRIM_PKGHOME` 缺失而失败），正常情况下卸载不会被 build 态阻塞。

**验证安装成功**：

```bash
docker images | grep fakenews-comics        # 应能看到 fakenews-comics:latest
docker ps | grep fakenews-comics            # STATUS 应为 Up
curl -s http://127.0.0.1:2233/api/health  # {"code":0,"data":{"ok":true,...}}
```

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)（GPL-3.0）发布。
