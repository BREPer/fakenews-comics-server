// settings 路由：阅读偏好等设置（服务端持久，前端 localStorage 镜像）。
// settings 路由（DEFAULTS / INTERNAL_KEYS / 即时生效动作）。
package routes

import (
	"encoding/json"
	"net/http"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/images"
	"fakenews-comics/internal/scanner"
)

// settingDefaults 设置缺省值（与前端 SETTINGS_DEFAULTS 对齐）。
//
// 只保留**服务端会执行**的项：
//   autoScanIntervalHours → scanner/scheduler.go 的定时器
//   thumbnailCacheMB      → images/cache.go 的缓存上限
//
// 阅读偏好与外观（readerMode/readDir/fitMode/quality/preloadCount/pageAnimation/
// keepScreenOn/pinchZoom/theme/accent）已改为**按设备存**在浏览器 localStorage，
// 服务端不再保存、不再下发。
var settingDefaults = map[string]any{
	"autoScanIntervalHours": 0,
	"thumbnailCacheMB":      2048,
	"note":                  "",
}

// internalKeys 内部记账键（不是用户设置）：不回传前端、不接受前端写入。
var internalKeys = map[string]bool{
	"scanMetaVersion":      true,
	"defaultLibrarySeeded": true,
	// 认证相关：凭据绝不能出现在 GET /api/settings 里，也不能被前端直接改写
	// （开关走 PUT /api/auth/enabled，密码走 PUT /api/auth/credentials）
	"authEnabled":  true,
	"authUser":     true,
	"authSalt":     true,
	"authPassHash": true,
}

// deprecatedKeys 已废弃的设置键：功能删除后老库里可能残留旧行
//   - volumeKeyPage：音量键翻页（2026-10 移除）
//   - 10 项阅读偏好/外观：改为按设备存（2026-10-24）
//
// 不回传前端、也不接受写入，否则 GET /api/settings 会带上前端类型里没有的幽灵字段。
var deprecatedKeys = map[string]bool{
	"volumeKeyPage":  true,
	"readerMode":     true,
	"readDir":        true,
	"fitMode":        true,
	"quality":        true,
	"preloadCount":   true,
	"pageAnimation":  true,
	"keepScreenOn":   true,
	"pinchZoom":      true,
	"theme":          true,
	"accent":         true,
}

// legacyPrefKeys 旧版「按账号存」的偏好键：只用于一次性迁移到本机。
// 前端读到后写进 localStorage，随后调用 consume 把它们从库里删掉 ——
// 偏好按设备独立的必然结果：第二台设备不该继承第一台的选择。
var legacyPrefKeys = map[string]bool{
	"readerMode":    true,
	"readDir":       true,
	"fitMode":       true,
	"quality":       true,
	"preloadCount":  true,
	"pageAnimation": true,
	"keepScreenOn":  true,
	"pinchZoom":     true,
	"theme":         true,
	"accent":        true,
}

// isHiddenSetting 内部记账键 + 已废弃键：对前端不可见。
func isHiddenSetting(k string) bool {
	return internalKeys[k] || deprecatedKeys[k]
}

func registerSettings(mux *http.ServeMux, e env.Env) {
	// GET /api/settings —— 合并缺省值
	mux.HandleFunc("GET /api/settings", adapt(func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.Get(e).Prepare("SELECT key, value FROM settings").All()
		if err != nil {
			return err
		}
		merged := map[string]any{}
		for k, v := range settingDefaults {
			merged[k] = v
		}
		for _, row := range rows {
			k := db.AsString(row, "key")
			if isHiddenSetting(k) {
				continue
			}
			var v any
			if err := json.Unmarshal([]byte(db.AsString(row, "value")), &v); err == nil {
				merged[k] = v
			}
		}
		httputil.WriteData(w, merged)
		return nil
	}))

	// PUT /api/settings —— 批量写入（内部记账键 / 已废弃键拒绝）
	mux.HandleFunc("PUT /api/settings", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var body map[string]any
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		d := db.Get(e)
		err := d.Tx(func(tx *db.Tx) error {
			for k, v := range body {
				if isHiddenSetting(k) {
					continue
				}
				b, err := json.Marshal(v)
				if err != nil {
					continue
				}
				if _, err := tx.Prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").
					Run(k, string(b)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		// 设置变更后的即时生效动作
		if _, ok := body["autoScanIntervalHours"]; ok {
			scanner.ScheduleAutoScan(e)
		}
		// 上限改小：立即按新上限淘汰一次
		if _, ok := body["thumbnailCacheMB"]; ok {
			_, _ = images.Evict(e)
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// GET /api/settings/legacy-prefs —— 旧版按账号存的 10 项偏好（一次性迁移用）
	//
	// 这些键已从 /api/settings 移除，但老库里还有值。升级用户首次访问时前端读一次、
	// 写进 localStorage，然后调 consume 删掉服务端这份 —— 这样第二台设备首访
	// 不会继承第一台的选择（偏好按设备独立）。
	mux.HandleFunc("GET /api/settings/legacy-prefs", adapt(func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.Get(e).Prepare("SELECT key, value FROM settings").All()
		if err != nil {
			return err
		}
		out := map[string]any{}
		for _, row := range rows {
			k := db.AsString(row, "key")
			if !legacyPrefKeys[k] {
				continue
			}
			var v any
			if err := json.Unmarshal([]byte(db.AsString(row, "value")), &v); err == nil {
				out[k] = v
			}
		}
		httputil.WriteData(w, out)
		return nil
	}))

	// POST /api/settings/legacy-prefs/consume —— 迁移完成，删除服务端这份
	mux.HandleFunc("POST /api/settings/legacy-prefs/consume", adapt(func(w http.ResponseWriter, r *http.Request) error {
		d := db.Get(e)
		removed := int64(0)
		err := d.Tx(func(tx *db.Tx) error {
			for k := range legacyPrefKeys {
				n, err := tx.Prepare("DELETE FROM settings WHERE key = ?").Run(k)
				if err != nil {
					return err
				}
				removed += n
			}
			return nil
		})
		if err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true, "removed": removed})
		return nil
	}))
}
