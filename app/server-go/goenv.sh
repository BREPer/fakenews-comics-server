# Go 工具链环境（可选，不是必须 source）。
#
# 大多数机器不需要这个文件：go 已在 PATH 上时，直接
#     cd app/server-go && go run .
# 即可。本文件只为「go 不在 PATH 上」的隔离工具链环境准备：
#     . ./goenv.sh && "$GO" build ./...
#
# 探测顺序（不会把不存在的路径写进环境变量）：
#   1) $GO_EXE 显式指定
#   2) PATH 上的 go
# 都探测不到时只打印提示、不导出任何变量，避免污染后续命令。
#
# 可用环境变量覆盖：GO_EXE / GO_ROOT / GOPATH / GOMODCACHE / GOPROXY / GOSUMDB

_go_exe=""
_go_root=""

if [ -n "${GO_EXE:-}" ] && [ -x "${GO_EXE}" ]; then
  _go_exe="${GO_EXE}"
  _go_root="${GO_ROOT:-}"
elif command -v go >/dev/null 2>&1; then
  _go_exe="$(command -v go)"
  _go_root="${GO_ROOT:-}"
fi

if [ -z "${_go_exe}" ]; then
  echo "[goenv] 未找到 go：请先安装 Go >= 1.26（https://go.dev/dl/）或设置 GO_EXE。未导出任何变量。" >&2
else
  export GO="${_go_exe}"
  if [ -n "${_go_root}" ]; then
    export GOROOT="${_go_root}"
  fi
  export GOFLAGS="${GOFLAGS:--buildvcs=false}"
  export GOPROXY="${GOPROXY:-https://mirrors.aliyun.com/goproxy/,direct}"
  export GOSUMDB="${GOSUMDB:-off}"
  export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"
  echo "[goenv] GO=${GO}${GOROOT:+  GOROOT=${GOROOT}}  (依赖已随 third_party 携带，无需联网拉模块)"
fi

unset _go_exe _go_root
