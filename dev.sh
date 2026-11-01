#!/usr/bin/env bash
# 本地开发一键启动（git-bash / macOS / Linux）
#
#   ./dev.sh                      # 默认：后端 13800，前端 127.0.0.1:5173
#   COMIC_ROOT=/path/to/comics ./dev.sh
#   APP_PORT=13900 WEB_PORT=5273 ./dev.sh
#
# 做三件事：确保依赖与二进制就绪 → 起 Go 后端（日志落 .dev-data/server.log）→ 前台跑 vite。
# Ctrl-C 会同时收掉后端。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

APP_PORT="${APP_PORT:-13800}"
WEB_PORT="${WEB_PORT:-5173}"
COMIC_ROOT="${COMIC_ROOT:-$ROOT/.dev-comics}"
DATA_DIR="${DATA_DIR:-$ROOT/app/server-go/.dev-data}"
WEB_DIST="${WEB_DIST:-$ROOT/app/web/dist}"

# ---- go 可用性：PATH 上没有就依次尝试 GO_EXE / 常见安装位置 / goenv.sh ----
if ! command -v go >/dev/null 2>&1; then
  for c in "${GO_EXE:-}" "/c/Program Files/Go/bin/go.exe" "/usr/local/go/bin/go"; do
    if [ -n "$c" ] && [ -x "$c" ]; then
      export PATH="$(dirname "$c"):$PATH"
      break
    fi
  done
fi
if ! command -v go >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  . "$ROOT/app/server-go/goenv.sh" >/dev/null 2>&1 || true
  if [ -n "${GO:-}" ]; then
    export PATH="$(dirname "$GO"):$PATH"
  fi
fi
if ! command -v go >/dev/null 2>&1; then
  echo "[dev] 未找到 go，请安装 Go >= 1.26，或用 GO_EXE=/path/to/go 指定" >&2
  exit 1
fi
echo "[dev] $(go version)"

# 国内网络下官方代理常不可达，未显式指定时走镜像（可用 GOPROXY=... 覆盖）
export GOPROXY="${GOPROXY:-https://mirrors.aliyun.com/goproxy/,direct}"
export GOSUMDB="${GOSUMDB:-off}"
export GOFLAGS="${GOFLAGS:--buildvcs=false}"

# ---- 漫画库：不存在就提示用测试数据 ----
if [ ! -d "$COMIC_ROOT" ]; then
  mkdir -p "$COMIC_ROOT"
  echo "[dev] COMIC_ROOT=$COMIC_ROOT 为空目录"
  echo "[dev] 想快速有内容：python tools/make_test_data.py 然后 COMIC_ROOT=\"\$TEMP/fakenews-comics\" ./dev.sh"
fi

# ---- 前端依赖与产物 ----
if [ ! -d app/web/node_modules ]; then
  echo "[dev] 安装前端依赖…"
  (cd app/web && npm install --no-fund --no-audit)
fi
if [ ! -d "$WEB_DIST" ]; then
  echo "[dev] 首次构建前端产物（后端静态伺服用）…"
  (cd app/web && npm run build)
fi

# ---- 后端：增量编译后后台启动 ----
mkdir -p "$DATA_DIR" app/server-go/bin
echo "[dev] 编译 Go 后端…"
(cd app/server-go && CGO_ENABLED=0 go build -o bin/server .)

BIN="$ROOT/app/server-go/bin/server"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
( cd app/server-go && \
  APP_PORT="$APP_PORT" HOST=127.0.0.1 COMIC_ROOT="$COMIC_ROOT" \
  DATA_DIR="$DATA_DIR" WEB_DIST="$WEB_DIST" "$BIN" \
  > "$DATA_DIR/server.log" 2>&1 ) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 40); do
  if curl -s -m 1 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if curl -s -m 2 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
  echo "[dev] 后端就绪 http://127.0.0.1:$APP_PORT  (日志: $DATA_DIR/server.log)"
else
  echo "[dev] 后端未就绪，看日志: $DATA_DIR/server.log" >&2
  tail -20 "$DATA_DIR/server.log" >&2 || true
  exit 1
fi

echo "[dev] 前端 http://127.0.0.1:$WEB_PORT   (Ctrl-C 一并停止后端)"
cd app/web
exec npm run dev -- --host 127.0.0.1 --port "$WEB_PORT" --strictPort
