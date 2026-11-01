// Package routes API 路由注册与统一错误适配。
// 路由模式用 Go 1.22+ net/http 通配符（GET /api/comics/{id}/...），零框架依赖。
package routes

import (
	"errors"
	"io/fs"
	"net/http"
	"runtime/debug"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/logger"
	"fakenews-comics/internal/sources"
)

// Register 注册全部 /api 路由。
func Register(mux *http.ServeMux, e env.Env) {
	registerHealth(mux, e)
	registerComics(mux, e)
	registerPages(mux, e)
	registerProgress(mux, e)
	registerFavorites(mux, e)
	registerScan(mux, e)
	registerLibraries(mux, e)
	registerSettings(mux, e)
	registerCache(mux, e)
	registerBackup(mux, e)
	registerUpload(mux, e)
	registerAuth(mux, e)
}

// adapt 统一错误信封 + panic 兜底。
func adapt(h httputil.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				logger.Error("panic", "err", rec, "url", r.URL.Path, "stack", string(debug.Stack()))
				httputil.WriteError(w, http.StatusInternalServerError, 5000, "internal error")
			}
		}()
		if err := h(w, r); err != nil {
			writeErr(w, r, err)
		}
	}
}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *lib.APIError
	if errors.As(err, &apiErr) {
		httputil.WriteError(w, apiErr.Status, apiErr.Code, apiErr.Message)
		return
	}
	var srcErr *sources.SourceError
	if errors.As(err, &srcErr) {
		httputil.WriteError(w, srcErr.Status, 5000, srcErr.Msg)
		return
	}
	// 页索引越界 → 404。
	// 漏了这层映射时越界页会变成 500，前端只能显示「加载失败」，排查时也容易误判成源码损坏。
	if errors.Is(err, sources.ErrPageOutOfRange) {
		httputil.WriteError(w, http.StatusNotFound, 4040, err.Error())
		return
	}
	// 写盘权限不足 → 403（容器里 ComicRoot 默认 `:ro` 挂载，上传/缓存写入会撞这个）。
	// 统一成 403 + 可读文案，比把裸 "access is denied" 塞进 500 更容易定位。
	if errors.Is(err, fs.ErrPermission) {
		logger.Warn("permission denied", "err", err, "url", r.URL.Path)
		httputil.WriteError(w, http.StatusForbidden, 5000, "permission denied: "+err.Error())
		return
	}
	var rangeErr *lib.RangeError
	if errors.As(err, &rangeErr) {
		w.Header().Set("content-range", "bytes */"+itoa(rangeErr.Total))
		w.Header().Set("accept-ranges", "bytes")
		httputil.WriteError(w, http.StatusRequestedRangeNotSatisfiable, 5000, "range not satisfiable")
		return
	}
	logger.Error("handler error", "err", err, "url", r.URL.Path)
	httputil.WriteError(w, http.StatusInternalServerError, 5000, err.Error())
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
