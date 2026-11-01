// favorites / history 路由：收藏增删查 + 最近阅读时间线。
// favorites 路由。
package routes

import (
	"net/http"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
)

func registerFavorites(mux *http.ServeMux, e env.Env) {
	ensureComic := func(comicID string) error {
		row, _ := db.Get(e).Prepare("SELECT 1 AS ok FROM comics WHERE id = ?").Get(comicID)
		if row == nil {
			return lib.NotFound("comic not found")
		}
		return nil
	}
	insertFav := func(comicID string) error {
		_, err := db.Get(e).Prepare("INSERT OR IGNORE INTO favorites (comic_id, created_at) VALUES (?, ?)").
			Run(comicID, time.Now().UnixMilli())
		return err
	}

	// GET /api/favorites —— 收藏列表（含漫画信息）
	mux.HandleFunc("GET /api/favorites", adapt(func(w http.ResponseWriter, r *http.Request) error {
		// 复用列表/详情投影：收藏页也需要 is_favorite 与 p_* 进度字段，
		// 自己手写 SELECT 会漏掉它们（红心消失、单章书误标已读完）。
		rows, err := db.Get(e).Prepare(comicSelect + " WHERE f.comic_id IS NOT NULL ORDER BY f.created_at DESC").All()
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, ToComicOut(row))
		}
		httputil.WriteData(w, map[string]any{"items": items})
		return nil
	}))

	// POST /api/favorites/{comicId} —— 收藏（comicId 为 "_" 时取 body）
	mux.HandleFunc("POST /api/favorites/{comicId}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		if comicID == "_" {
			var body struct {
				ComicID string `json:"comicId"`
			}
			if err := httputil.DecodeJSON(r, &body); err != nil {
				return lib.BadRequest("invalid json body")
			}
			comicID = body.ComicID
		}
		if comicID == "" {
			return lib.BadRequest("comicId required")
		}
		if err := ensureComic(comicID); err != nil {
			return err
		}
		if err := insertFav(comicID); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// POST /api/favorites —— 收藏（body 形式）
	mux.HandleFunc("POST /api/favorites", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			ComicID string `json:"comicId"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		if body.ComicID == "" {
			return lib.BadRequest("comicId required")
		}
		if err := ensureComic(body.ComicID); err != nil {
			return err
		}
		if err := insertFav(body.ComicID); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// DELETE /api/favorites/{comicId} —— 取消收藏
	mux.HandleFunc("DELETE /api/favorites/{comicId}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		db.Get(e).Prepare("DELETE FROM favorites WHERE comic_id = ?").Run(r.PathValue("comicId"))
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// GET /api/history?limit=50&offset=0 —— 最近阅读（updated_at 倒序，含章节/页码上下文）
	//
	// offset + total 是为了修「阅读记录只显示最新 100 条」：以前只有 limit，
	// 前端写死 limit=100，读过 100 本以上时更早的记录就再也点不到了（没有入口）。
	mux.HandleFunc("GET /api/history", adapt(func(w http.ResponseWriter, r *http.Request) error {
		limit := httputil.QueryInt(r, "limit", 50, 1, 200)
		offset := httputil.QueryInt(r, "offset", 0, 0, 1<<30)
		d := db.Get(e)
		totalRow, err := d.Prepare("SELECT COUNT(*) AS n FROM reading_progress").Get()
		if err != nil {
			return err
		}
		total := db.AsInt(totalRow, "n")
		rows, err := d.Prepare(`
      SELECT c.*, p.chapter_id AS p_chapter_id, p.chapter_index AS p_chapter_index,
             p.page_index AS p_page_index, p.page_count AS p_page_count,
             p.percent AS p_percent, p.updated_at AS p_updated_at
      FROM reading_progress p
      JOIN comics c ON c.id = p.comic_id
      ORDER BY p.updated_at DESC
      LIMIT ? OFFSET ?
    `).All(limit, offset)
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			out := ToComicOut(row)
			out["chapterId"] = db.AsString(row, "p_chapter_id")
			out["chapterIndex"] = db.AsInt(row, "p_chapter_index")
			out["pageIndex"] = db.AsInt(row, "p_page_index")
			out["progressPageCount"] = db.AsInt(row, "p_page_count")
			items = append(items, out)
		}
		httputil.WriteData(w, map[string]any{"items": items, "total": total})
		return nil
	}))

	// DELETE /api/history/{comicId} —— 删除单条阅读记录
	mux.HandleFunc("DELETE /api/history/{comicId}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		d := db.Get(e)
		if _, err := d.Prepare("DELETE FROM reading_progress WHERE comic_id = ?").Run(comicID); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))
}
