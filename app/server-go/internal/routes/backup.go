// backup 路由：阅读数据导出 / 导入（进度、收藏、设置）。
// 导入为合并语义（不删除本地数据），且只接受本机存在的漫画（comicId 基于路径哈希）。
// backup 路由（导出 / 导入）。
package routes

import (
	"encoding/json"
	"net/http"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
)

const backupVersion = 1

func registerBackup(mux *http.ServeMux, e env.Env) {
	// GET /api/backup/export —— 导出全部阅读数据（JSON，可直接保存为文件）
	mux.HandleFunc("GET /api/backup/export", adapt(func(w http.ResponseWriter, r *http.Request) error {
		d := db.Get(e)
		progress, err := d.Prepare("SELECT * FROM reading_progress ORDER BY updated_at DESC").All()
		if err != nil {
			return err
		}
		favorites, err := d.Prepare("SELECT * FROM favorites ORDER BY created_at DESC").All()
		if err != nil {
			return err
		}
		settingsRows, err := d.Prepare("SELECT key, value FROM settings").All()
		if err != nil {
			return err
		}
		settingsObj := map[string]any{}
		for _, s := range settingsRows {
			// 内部记账键与废弃键不进备份：它们要么是安全相关，要么已经不属于服务端
			// （阅读偏好/外观改为按设备存，备份里的设备偏好由前端作为 devicePrefs 附加）
			if isHiddenSetting(db.AsString(s, "key")) {
				continue
			}
			var v any
			if err := json.Unmarshal([]byte(db.AsString(s, "value")), &v); err == nil {
				settingsObj[db.AsString(s, "key")] = v
			}
		}
		progressOut := make([]map[string]any, 0, len(progress))
		for _, row := range progress {
			progressOut = append(progressOut, map[string]any{
				"comicId": db.AsString(row, "comic_id"), "chapterId": db.AsString(row, "chapter_id"),
				"chapterIndex": db.AsInt(row, "chapter_index"), "pageIndex": db.AsInt(row, "page_index"),
				"pageCount": db.AsInt(row, "page_count"), "percent": db.AsFloat(row, "percent"),
				"updatedAt": db.AsInt64(row, "updated_at"),
			})
		}
		favOut := make([]map[string]any, 0, len(favorites))
		for _, row := range favorites {
			favOut = append(favOut, map[string]any{
				"comicId": db.AsString(row, "comic_id"), "createdAt": db.AsInt64(row, "created_at"),
			})
		}
		httputil.WriteData(w, map[string]any{
			"version": backupVersion, "exportedAt": time.Now().UnixMilli(),
			"progress": progressOut, "favorites": favOut, "settings": settingsObj,
		})
		return nil
	}))

	// POST /api/backup/import —— 合并导入（只接受本机存在的漫画）
	mux.HandleFunc("POST /api/backup/import", adapt(func(w http.ResponseWriter, r *http.Request) error {
		// 老备份文件里可能还带 chapterProgress（分章进度，功能已删）：字段保留但不导入
		var b struct {
			Progress        []map[string]any `json:"progress"`
			ChapterProgress []map[string]any `json:"chapterProgress"`
			Favorites       []map[string]any `json:"favorites"`
			Settings        map[string]any   `json:"settings"`
		}
		if err := httputil.DecodeJSON(r, &b); err != nil {
			return lib.BadRequest("invalid json body")
		}
		d := db.Get(e)
		idRows, err := d.Prepare("SELECT id FROM comics").All()
		if err != nil {
			return err
		}
		known := map[string]bool{}
		for _, row := range idRows {
			known[db.AsString(row, "id")] = true
		}

		nProgress, nFav, nSettings, skipped := 0, 0, 0, 0
		now := time.Now().UnixMilli()
		err = d.Tx(func(tx *db.Tx) error {
			stmtProgress := tx.Prepare(`
        INSERT INTO reading_progress (comic_id, chapter_id, chapter_index, page_index, page_count, percent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(comic_id) DO UPDATE SET
          chapter_id = excluded.chapter_id, chapter_index = excluded.chapter_index,
          page_index = excluded.page_index, page_count = excluded.page_count,
          percent = excluded.percent, updated_at = excluded.updated_at
        WHERE excluded.updated_at >= reading_progress.updated_at
      `)
			stmtFav := tx.Prepare("INSERT OR IGNORE INTO favorites (comic_id, created_at) VALUES (?, ?)")
			stmtSetting := tx.Prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")

			for _, row := range b.Progress {
				comicID, _ := row["comicId"].(string)
				if !known[comicID] {
					skipped++
					continue
				}
				ua := asInt64Or(row["updatedAt"], now)
				if _, err := stmtProgress.Run(comicID, asString(row["chapterId"]),
					asInt(row["chapterIndex"]), asInt(row["pageIndex"]), asIntOr(row["pageCount"], 1),
					asFloat(row["percent"]), ua); err != nil {
					return err
				}
				nProgress++
			}
			for _, row := range b.Favorites {
				comicID, _ := row["comicId"].(string)
				if !known[comicID] {
					skipped++
					continue
				}
				if _, err := stmtFav.Run(comicID, asInt64Or(row["createdAt"], now)); err != nil {
					return err
				}
				nFav++
			}
			for k, v := range b.Settings {
				if k == "" || len(k) > 80 {
					continue
				}
				// 隐藏键一律不写：老备份文件里可能还带着 theme/accent 等
				// 已改为"按设备存"的键，写回去只会在库里留垃圾
				if isHiddenSetting(k) {
					continue
				}
				bv, err := json.Marshal(v)
				if err != nil {
					continue
				}
				if _, err := stmtSetting.Run(k, string(bv)); err != nil {
					return err
				}
				nSettings++
			}
			return nil
		})
		if err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{
			"ok": true,
			"imported": map[string]any{
				"progress": nProgress, "favorites": nFav, "settings": nSettings,
			},
			"skipped": skipped,
		})
		return nil
	}))
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		return 0
	default:
		return 0
	}
}

// asFloat 读备份里的 percent（REAL，带小数）。整数形态（老备份）也兼容。
func asFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	default:
		return 0
	}
}

func asIntOr(v any, dflt int) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	default:
		return dflt
	}
}

func asInt64Or(v any, dflt int64) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	default:
		return dflt
	}
}
