// progress 路由：阅读进度读写（阅读器高频写）+ 重置。
// percent 为**全书维度**，由服务端按章累计计算（前序章页数 + 本章已读页 / 全书页数）；
// readStatus 的 finished 由 isBookFinished 判定（停在最后一章且读到末页）。
// 只维护 reading_progress（一漫画一行 = 当前正在读的章节位置）；
// 早期的 chapter_progress（每章进度）已整体移除，见 schema.sql。
// progress 路由（进度读写 / 重置）。
package routes

import (
	"net/http"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/scanner"
)

func registerProgress(mux *http.ServeMux, e env.Env) {
	// GET /api/progress?comicIds=a,b,c —— 列表页批量聚合
	mux.HandleFunc("GET /api/progress", adapt(func(w http.ResponseWriter, r *http.Request) error {
		ids := splitCSV(r.URL.Query().Get("comicIds"))
		d := db.Get(e)
		var rows []map[string]any
		var err error
		if len(ids) == 0 {
			rows, err = d.Prepare("SELECT * FROM reading_progress ORDER BY updated_at DESC LIMIT 200").All()
		} else {
			ph := make([]string, len(ids))
			args := make([]any, len(ids))
			for i, id := range ids {
				ph[i] = "?"
				args[i] = id
			}
			rows, err = d.Prepare("SELECT * FROM reading_progress WHERE comic_id IN (" + joinComma(ph) + ")").All(args...)
		}
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, toProgressOut(row))
		}
		httputil.WriteData(w, map[string]any{"items": items})
		return nil
	}))

	// PUT /api/progress —— 上报（防抖由前端控制，服务端幂等 upsert）
	mux.HandleFunc("PUT /api/progress", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			ComicID      *string  `json:"comicId"`
			ChapterID    *string  `json:"chapterId"`
			ChapterIndex *float64 `json:"chapterIndex"`
			PageIndex    *float64 `json:"pageIndex"`
			PageCount    *float64 `json:"pageCount"`
			Percent      *float64 `json:"percent"`
			// UpdatedAt 允许客户端指定时间戳：**只给「撤销删除阅读记录」用**。
			// 撤销时如果按 now 写回，这条记录会跳到历史列表最前面 —— 用户看到的是
			// 「撤销了，但顺序变了」，比不撤销更困惑。缺省/非法值一律按 now。
			UpdatedAt *float64 `json:"updatedAt"`
		}
		if err := httputil.DecodeJSON(r, &b); err != nil {
			return lib.BadRequest("invalid json body")
		}
		comicID, err := lib.NeedString(deref(b.ComicID), "comicId", 64)
		if err != nil {
			return err
		}
		chapterID, err := lib.NeedString(deref(b.ChapterID), "chapterId", 80)
		if err != nil {
			return err
		}
		chapterIndex, err := lib.NeedInt(derefF(b.ChapterIndex), "chapterIndex", 0, 1<<30)
		if err != nil {
			return err
		}
		pageIndex, err := lib.NeedInt(derefF(b.PageIndex), "pageIndex", 0, 1<<30)
		if err != nil {
			return err
		}
		pageCount, err := lib.NeedInt(derefF(b.PageCount), "pageCount", 1, 1<<30)
		if err != nil {
			return err
		}
		d := db.Get(e)
		// 连 comics + libraries 一起取：算全书进度需要路径/格式，章节型库决定章的列举方式
		comic, _ := d.Prepare(`
      SELECT c.id, c.path, c.format, c.chapter_count, l.type AS lib_type
      FROM comics c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`).Get(comicID)
		if comic == nil {
			return lib.NotFound("comic not found")
		}
		chapterCount := db.AsInt(comic, "chapter_count")
		if chapterCount > 0 && chapterIndex >= chapterCount {
			// 章节号越界：前端 bug 或扫描结果刚变。静默修正会让「第 N 章」显示错位置，
			// 直接报错让问题暴露在上报那一刻
			return lib.BadRequest("chapterIndex out of range")
		}

		// percent 一律按**全书维度**在服务端算：前序章页数 + 本章已读页，除以全书总页数。
		//
		// 以前直接存前端传的章内百分比，而 readStatus 用 `percent >= 100` 判定读完 ——
		// 于是「读完多章漫画的第 1 章」整本书就被标成已读完（卡片出「已读完」角标、
		// 详情页按钮退回「开始阅读」）。注释里写的「按章累计计算」当时并没有实现。
		// 章页数走 scanner 的章节/页数缓存（命中即内存查找），翻页 1s 才上报一次，开销可忽略。
		percent := bookPercent(e, comic, chapterIndex, pageIndex, pageCount, b.Percent)
		now := time.Now().UnixMilli()
		updatedAt := now
		if b.UpdatedAt != nil {
			// 只接受「过去且不太离谱」的时间戳：未来时间会让这条记录永远钉在历史首位，
			// 0/负数会让它沉到底部，两者都像数据损坏。
			if ts := int64(*b.UpdatedAt); ts > 0 && ts <= now+60_000 {
				updatedAt = ts
			}
		}
		// 只写「当前正在阅读的章节」：reading_progress 一行一漫画，天然就是当前章位置。
		// 早期的 chapter_progress（每章一行）已整体移除 —— 非当前章不该有进度数据，
		// 章节列表里的「已读 / 百分比」也一并不再提供。
		if _, err := d.Prepare(`
      INSERT INTO reading_progress (comic_id, chapter_id, chapter_index, page_index, page_count, percent, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(comic_id) DO UPDATE SET
        chapter_id = excluded.chapter_id, chapter_index = excluded.chapter_index,
        page_index = excluded.page_index, page_count = excluded.page_count,
        percent = excluded.percent, updated_at = excluded.updated_at
    `).Run(comicID, chapterID, chapterIndex, pageIndex, pageCount, percent, updatedAt); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true, "percent": percent})
		return nil
	}))

	// POST /api/progress/{comicId}/reset —— 重置为未读
	mux.HandleFunc("POST /api/progress/{comicId}/reset", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		d := db.Get(e)
		d.Prepare("DELETE FROM reading_progress WHERE comic_id = ?").Run(comicID)
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))
}

func toProgressOut(row map[string]any) map[string]any {
	return map[string]any{
		"comicId":      db.AsString(row, "comic_id"),
		"chapterId":    db.AsString(row, "chapter_id"),
		"chapterIndex": db.AsInt(row, "chapter_index"),
		"pageIndex":    db.AsInt(row, "page_index"),
		"pageCount":    db.AsInt(row, "page_count"),
		// REAL 列 + 0.1 精度：必须用 AsFloat，AsInt 会把 6.7 截成 6
		"percent":    db.AsFloat(row, "percent"),
		"updatedAt":  db.AsInt64(row, "updated_at"),
	}
}

/**
 * bookPercent 全书已读百分比（0-100，可带 1 位小数）。
 *
 * 章页数来自 scanner.ListChapters + PageCountOf（两者都有缓存，命中即内存查找）。
 * 只有「拿不到章页数」时才回落到前端传的章内百分比 —— 那时至少单篇漫画
 * （全书一章）的值是对的，多章漫画会偏大，但比没有好。
 */
func bookPercent(e env.Env, comic map[string]any, chapterIndex, pageIndex, pageCount int, fallback *float64) float64 {
	comicID := db.AsString(comic, "id")
	chapters, err := scanner.ListChapters(
		db.AsString(comic, "path"), db.AsString(comic, "format"), comicID,
		db.AsString(comic, "lib_type") == "chapter",
	)
	if err != nil || len(chapters) == 0 {
		return fallbackPercent(fallback, pageIndex, pageCount)
	}
	format := db.AsString(comic, "format")
	total, before := 0, 0
	for i, ch := range chapters {
		n := ch.PageCount
		if n <= 0 {
			n = scanner.PageCountOf(ch.Path, firstNonEmpty(ch.Format, format), ch.Prefix, ch.TopOnly)
		}
		total += n
		if i < chapterIndex {
			before += n
		}
	}
	if total <= 0 {
		return fallbackPercent(fallback, pageIndex, pageCount)
	}
	read := before + min(pageIndex+1, pageCount)
	return clampFloat(float64(read)/float64(total)*100, 0, 100)
}

// fallbackPercent 章页数拿不到时的兜底：前端值 → 章内比例 → 0。
func fallbackPercent(fallback *float64, pageIndex, pageCount int) float64 {
	if fallback != nil && isFinite(*fallback) {
		return clampFloat(*fallback, 0, 100)
	}
	pc := pageCount
	if pc < 1 {
		pc = 1
	}
	return clampFloat(float64(pageIndex)/float64(pc)*100, 0, 100)
}

/**
 * isBookFinished 是否读完**整本书**：停在最后一章且本章读到末页。
 *
 * readStatus 以前用 `percent >= 100` 判定，而 percent 曾是章内值 —— 读完第 1 章
 * 就 100%，多章漫画被误标已读完。现在 percent 本身是全书维度，这个判定仍然保留：
 * 它是唯一权威（percent 拿不到时的兜底值不该把书标成读完）。
 */
func isBookFinished(chapterIndex, chapterCount, pageIndex, pageCount int) bool {
	if chapterCount <= 0 || chapterIndex+1 < chapterCount {
		return false
	}
	return pageIndex+1 >= pageCount
}

func deref(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func derefF(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}

func isFinite(f float64) bool {
	return f == f && f > -1e308 && f < 1e308
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func splitCSV(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(c)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ","
		}
		out += p
	}
	return out
}
