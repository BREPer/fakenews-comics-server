// cache 路由：缩略图/封面缓存的用量查询与手动清理。
// 上限与自动淘汰见 images/cache.go。
// cache 路由（用量 / 清理 / 淘汰）。
package routes

import (
	"net/http"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/images"
)

func registerCache(mux *http.ServeMux, e env.Env) {
	// GET /api/cache/stats —— 用量（设置页展示）
	mux.HandleFunc("GET /api/cache/stats", adapt(func(w http.ResponseWriter, r *http.Request) error {
		httputil.WriteData(w, images.GetCacheStats(e))
		return nil
	}))

	// POST /api/cache/clear —— 清空全部缓存
	mux.HandleFunc("POST /api/cache/clear", adapt(func(w http.ResponseWriter, r *http.Request) error {
		freed := images.ClearCache(e)
		httputil.WriteData(w, map[string]any{"ok": true, "freed": freed})
		return nil
	}))

	// POST /api/cache/evict —— 按上限立即淘汰一次（改小上限后立即生效）
	mux.HandleFunc("POST /api/cache/evict", adapt(func(w http.ResponseWriter, r *http.Request) error {
		freed, deleted := images.Evict(e)
		httputil.WriteData(w, map[string]any{
			"ok": true, "freed": freed, "deleted": deleted, "stats": images.GetCacheStats(e),
		})
		return nil
	}))
}
