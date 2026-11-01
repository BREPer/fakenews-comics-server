#!/usr/bin/env bash
# 肥牛漫画 fpk 打包助手（Linux / macOS / NAS SSH）
# 流程：构建前端 -> 交叉编译 Go 服务端（linux/amd64）-> 组装干净打包目录 .build/fpk -> fnpack build
# 首次运行会自动下载 fnpack 1.2.3 到 .toolchain/
#
# 服务端只有「一个静态二进制 + 前端 dist」，NAS 上镜像构建是两次 COPY（1~2 秒、零联网）。
# ARM 机器：GOARCH_TARGET=arm64 再执行本脚本，产物名与 Dockerfile 的 COPY 路径同步改。
#
# 环境变量：
#   SKIP_WEB=1     跳过前端构建（复用已有 app/web/dist；不存在则报错）
#   GO=<path>      指定 go 可执行文件
#   GOPROXY=...    模块代理（缺省取环境值，未设则用 Go 默认）
set -euo pipefail

# Windows 的 Git Bash 也认这个脚本，但 fnpack 只有与打包机同平台的可执行文件，
# 跑到最后一步才会报 Exec format error，前面全白编译——这里先拦掉。
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        echo "ERROR: 当前是 Windows 的 Git Bash，请改用 PowerShell 执行 build.ps1。" >&2
        echo "       （fnpack 需要与打包机同平台的二进制，本脚本下载的是 linux 版）" >&2
        exit 1
        ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_DIR="$ROOT/.toolchain"
FNPACK="$TOOL_DIR/fnpack"
STAGE="$ROOT/.build/fpk"
SERVER_GO="$ROOT/app/server-go"

GOARCH_TARGET="${GOARCH_TARGET:-amd64}"
GO="${GO:-go}"

# ---------- 1. 版本（单一真源：manifest） ----------
VERSION="$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*\([0-9][0-9.]*\).*/\1/p' "$ROOT/manifest" | head -1)"
if [ -z "$VERSION" ]; then
    echo "ERROR: 无法从 manifest 读取 version" >&2
    exit 1
fi
echo "版本: $VERSION"

# ---------- 2. 前端产物 ----------
WEB="$ROOT/app/web"
if [ "${SKIP_WEB:-0}" = "1" ]; then
    if [ ! -f "$WEB/dist/index.html" ]; then
        echo "ERROR: SKIP_WEB=1 但 $WEB/dist/index.html 不存在，没有可复用的产物" >&2
        exit 1
    fi
    echo "前端: 跳过构建，复用现有 dist（SKIP_WEB=1）"
else
    if ! command -v npm >/dev/null 2>&1; then
        echo "ERROR: 找不到 npm。打包需要 Node >= 22；想复用已有产物请设 SKIP_WEB=1" >&2
        exit 1
    fi
    if [ ! -d "$WEB/node_modules" ]; then
        echo "前端: 首次安装依赖 ..."
        ( cd "$WEB" && npm install --no-fund --no-audit ) || { echo "ERROR: npm install 失败" >&2; exit 1; }
    fi
    echo "构建前端 ..."
    ( cd "$WEB" && npm run build ) || { echo "ERROR: 前端构建失败" >&2; exit 1; }
    if [ ! -f "$WEB/dist/index.html" ]; then
        echo "ERROR: 前端构建完成但没有 $WEB/dist/index.html" >&2
        exit 1
    fi
fi

# ---------- 3. 交叉编译 Go 服务端 ----------
if ! command -v "$GO" >/dev/null 2>&1; then
    echo "ERROR: 找不到 go（用 GO=/path/to/go ./build.sh 指定）" >&2
    exit 1
fi

mkdir -p "$SERVER_GO/bin"
BIN_NAME="fakenews-comics-server-linux-$GOARCH_TARGET"
echo "交叉编译 linux/$GOARCH_TARGET ..."
# CGO_ENABLED=0：纯 Go（modernc sqlite / x-image / wazero PDFium），
# 产物是静态 ELF，可直接跑在 scratch 镜像里，也天然支持交叉编译。
(
    cd "$SERVER_GO"
    CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH_TARGET" GOFLAGS=-buildvcs=false \
        "$GO" build -trimpath \
        -ldflags "-s -w -X fakenews-comics/internal/version.AppVersion=$VERSION" \
        -o "bin/$BIN_NAME" .
)
echo "二进制: $SERVER_GO/bin/$BIN_NAME ($(du -h "$SERVER_GO/bin/$BIN_NAME" | cut -f1))"

# ---------- 4. 组装打包目录（只含 fpk 需要的文件） ----------
rm -rf "$STAGE"
mkdir -p "$STAGE"

cp "$ROOT/manifest" "$ROOT/ICON.PNG" "$ROOT/ICON_256.PNG" "$STAGE/"
cp -r "$ROOT/cmd" "$ROOT/config" "$ROOT/wizard" "$STAGE/"

mkdir -p "$STAGE/app"
cp -r "$ROOT/app/ui" "$STAGE/app/ui"
cp -r "$ROOT/app/docker" "$STAGE/app/docker"

# 服务端：Dockerfile + bin/ + web-dist/（compose 的 build context 就是这里）
SERVER_STAGE="$STAGE/app/server-go"
mkdir -p "$SERVER_STAGE/bin"
cp "$SERVER_GO/Dockerfile" "$SERVER_STAGE/"
cp "$SERVER_GO/bin/$BIN_NAME" "$SERVER_STAGE/bin/"
cp -r "$ROOT/app/web/dist" "$SERVER_STAGE/web-dist"

echo "Staged package tree:"
( cd "$STAGE" && find . -type f | sort | sed 's|^\./|  |' )

# ---------- 5. fnpack ----------
if [ ! -x "$FNPACK" ]; then
    mkdir -p "$TOOL_DIR"
    echo "Downloading fnpack 1.2.3 (linux-amd64) ..."
    curl -fL -o "$FNPACK" "https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64"
    chmod +x "$FNPACK"
fi

echo "Packing fakenews-comics ..."
# fnpack 将产物写入「进程工作目录」而非 --directory，故先切到 staging 目录
( cd "$STAGE" && "$FNPACK" build --directory "$STAGE" )

if [ -f "$STAGE/fakenews-comics.fpk" ]; then
    # 产物名带版本：多版本共存时不会互相覆盖，也便于在 NAS 上分辨装的是哪版
    OUT="$ROOT/fakenews-comics-$VERSION.fpk"
    mv "$STAGE/fakenews-comics.fpk" "$OUT"
    echo "OK -> $OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes, 版本 $VERSION)"
else
    echo "ERROR: fakenews-comics.fpk not generated. Check the fnpack output above." >&2
    exit 1
fi
