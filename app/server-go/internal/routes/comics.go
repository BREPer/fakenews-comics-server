// comics 路由：列表（聚合进度/收藏态）/ 详情 / 元数据编辑 / 自定义封面 / 单部重扫。
// comics 路由（列表 / 详情 / 封面 / 元数据）。
package routes

import (
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/images"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/scanner"
	"fakenews-comics/internal/sources"
)

// comicSelect 列表/详情共用投影：进度聚合 + 收藏标记 + 库类型，全部 JOIN 一次拿全。
const comicSelect = `
  SELECT c.*,
         p.chapter_id AS p_chapter_id, p.chapter_index AS p_chapter_index,
         p.page_index AS p_page_index, p.page_count AS p_page_count,
         p.percent AS p_percent, p.updated_at AS p_updated_at,
         (f.comic_id IS NOT NULL) AS is_favorite,
         l.type AS lib_type
  FROM comics c
  LEFT JOIN reading_progress p ON p.comic_id = c.id
  LEFT JOIN favorites f ON f.comic_id = c.id
  LEFT JOIN libraries l ON l.id = c.library_id
`

// sortCol DB 排序列（title 不在此列：中文按拼音排，进程内处理）。
var sortCol = map[string]string{
	"addedAt":    "c.added_at",
	"lastReadAt": "COALESCE(p.updated_at, 0)",
	"progress":   "COALESCE(p.percent, 0)",
}

func registerComics(mux *http.ServeMux, e env.Env) {
	// GET /api/comics —— 列表 + 阅读态聚合（避免前端 N+1）
	mux.HandleFunc("GET /api/comics", adapt(func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		var where []string
		var args []any
		where = append(where, "1=1")
		if v := q.Get("libraryId"); v != "" {
			where = append(where, "c.library_id = ?")
			args = append(args, v)
		}
		// 搜索范围：标题 / 原始文件名 / 作者 / 简介 / 标签
		if needle := lib.SanitizeQuery(q.Get("q"), 100); needle != "" {
			where = append(where,
				"(c.title LIKE ? ESCAPE '\\' OR c.raw_title LIKE ? ESCAPE '\\' OR c.author LIKE ? ESCAPE '\\' "+
					"OR c.description LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')")
			like := "%" + lib.EscapeLike(needle) + "%"
			args = append(args, like, like, like, like, like)
		}
		if v := q.Get("format"); v != "" {
			where = append(where, "c.format = ?")
			args = append(args, v)
		}
		if v := q.Get("tag"); v != "" {
			where = append(where, "c.tags LIKE ? ESCAPE '\\'")
			args = append(args, "%\""+lib.EscapeLike(lib.SanitizeQuery(v, 40))+"\"%")
		}
		switch q.Get("status") {
		case "reading":
			where = append(where, "p.updated_at IS NOT NULL AND COALESCE(p.percent,0) < 100")
		case "unread":
			where = append(where, "p.updated_at IS NULL")
		case "finished":
			where = append(where, "COALESCE(p.percent,0) >= 100")
		}
		whereSQL := strings.Join(where, " AND ")

		sortKey := q.Get("sort")
		if sortKey == "" {
			sortKey = "addedAt"
		}
		order := "DESC"
		if q.Get("order") == "asc" {
			order = "ASC"
		}
		page := httputil.QueryInt(r, "page", 1, 1, 100000)
		pageSize := httputil.QueryInt(r, "pageSize", 60, 1, 200)
		offset := (page - 1) * pageSize

		d := db.Get(e)
		totalRow, err := d.Prepare(
			"SELECT COUNT(*) AS n FROM comics c LEFT JOIN reading_progress p ON p.comic_id = c.id WHERE " + whereSQL,
		).Get(args...)
		if err != nil {
			return err
		}
		total := db.AsInt64(totalRow, "n")

		var rows []map[string]any
		if sortKey == "title" {
			// 中文拼音序：只取 (id, title) 进程内排，按当前页 id 回取整行
			keys, err := d.Prepare(
				"SELECT c.id, c.title FROM comics c LEFT JOIN reading_progress p ON p.comic_id = c.id WHERE " + whereSQL,
			).All(args...)
			if err != nil {
				return err
			}
			dir := 1
			if order == "DESC" {
				dir = -1
			}
			sort.SliceStable(keys, func(i, j int) bool {
				ci := sources.CompareZH(db.AsString(keys[i], "title"), db.AsString(keys[j], "title"))
				if ci != 0 {
					return ci*dir < 0
				}
				// 同名用 id 兜底，保证分页稳定
				return db.AsString(keys[i], "id") < db.AsString(keys[j], "id")
			})
			lo := offset
			if lo > len(keys) {
				lo = len(keys)
			}
			hi := offset + pageSize
			if hi > len(keys) {
				hi = len(keys)
			}
			pageKeys := keys[lo:hi]
			ids := make([]string, len(pageKeys))
			for i, k := range pageKeys {
				ids[i] = db.AsString(k, "id")
			}
			rows = fetchByIDs(d, ids)
		} else {
			col, ok := sortCol[sortKey]
			if !ok {
				col = sortCol["addedAt"]
			}
			sql := comicSelect + " WHERE " + whereSQL + " ORDER BY " + col + " " + order + ", c.id LIMIT ? OFFSET ?"
			rows, err = d.Prepare(sql).All(append(args, pageSize, offset)...)
			if err != nil {
				return err
			}
		}

		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, ToComicOut(row))
		}
		httputil.WriteData(w, map[string]any{
			"items": items, "total": total, "page": page, "pageSize": pageSize,
			"hasMore": int64(offset+len(items)) < total,
		})
		return nil
	}))

	// GET /api/comics/facets —— 筛选 chips 聚合
	mux.HandleFunc("GET /api/comics/facets", adapt(func(w http.ResponseWriter, r *http.Request) error {
		httputil.WriteData(w, lib.GetFacets(e))
		return nil
	}))

	// GET /api/comics/{comicId} —— 详情 + 章列表
	mux.HandleFunc("GET /api/comics/{comicId}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		row, err := db.Get(e).Prepare(comicSelect + " WHERE c.id = ?").Get(comicID)
		if err != nil {
			return err
		}
		if row == nil {
			return lib.NotFound("comic not found")
		}
		comic := ToComicOut(row)
		chapters, err := scanner.ListChapters(db.AsString(row, "path"), db.AsString(row, "format"), comicID, db.AsString(row, "lib_type") == "chapter")
		if err != nil {
			return err
		}
		// 回填每章页数（folder 数图片 / 压缩包读中央目录，均不解压全文），限并发 4
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for i := range chapters {
			if chapters[i].PageCount != 0 {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(ch *scanner.ChapterInfo) {
				defer wg.Done()
				defer func() { <-sem }()
				ch.PageCount = scanner.PageCountOf(ch.Path, firstNonEmpty(ch.Format, db.AsString(row, "format")), ch.Prefix, ch.TopOnly)
			}(&chapters[i])
		}
		wg.Wait()
		totalPages := 0
		for _, c := range chapters {
			totalPages += c.PageCount
		}
		// 只维护「当前正在阅读的章节」进度（reading_progress），
		// 分章进度（chapter_progress）已整体移除：章节列表不再有已读/百分比数据
		chaptersOut := make([]map[string]any, len(chapters))
		for i, ch := range chapters {
			chaptersOut[i] = map[string]any{
				"id": ch.ID, "index": ch.Index, "title": ch.Title,
				"pageCount": ch.PageCount, "sizeBytes": ch.SizeBytes,
			}
		}
		out := map[string]any{}
		for k, v := range comic {
			out[k] = v
		}
		out["chapterCount"] = len(chapters)
		out["pageCount"] = totalPages
		out["chapters"] = chaptersOut
		httputil.WriteData(w, out)
		return nil
	}))

	// GET /api/comics/{comicId}/cover —— 封面缩略图
	mux.HandleFunc("GET /api/comics/{comicId}/cover", adapt(func(w http.ResponseWriter, r *http.Request) error {
		wq := httputil.QueryInt(r, "w", 320, 64, 1024)
		out, err := images.GetCover(e, r.PathValue("comicId"), wq)
		if err != nil {
			return err
		}
		w.Header().Set("content-type", out.ContentType)
		w.Header().Set("cache-control", "public, max-age=86400")
		w.Write(out.Buffer)
		return nil
	}))

	// POST /api/comics/{comicId}/scan —— 单部重扫
	mux.HandleFunc("POST /api/comics/{comicId}/scan", adapt(func(w http.ResponseWriter, r *http.Request) error {
		res, err := scanner.RescanComic(e, r.PathValue("comicId"))
		if err != nil {
			return err
		}
		if res == nil {
			return lib.NotFound("comic not found or path missing")
		}
		httputil.WriteData(w, res)
		return nil
	}))

	// PUT /api/comics/{comicId} —— 编辑元数据与分类标签（编辑后 meta_locked=1，重扫不覆盖）
	mux.HandleFunc("PUT /api/comics/{comicId}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		var body struct {
			Title       *string `json:"title"`
			Author      *string `json:"author"`
			Description *string `json:"description"`
			Tags        *[]any  `json:"tags"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		row := images.GetComicRow(e, comicID)
		if row == nil {
			return lib.NotFound("comic not found")
		}
		var sets []string
		var args []any
		sets = append(sets, "meta_locked = 1")
		if body.Title != nil {
			title, err := lib.NeedString(*body.Title, "title", 300)
			if err != nil {
				return err
			}
			sets = append(sets, "title = ?")
			args = append(args, title)
		}
		if body.Author != nil {
			sets = append(sets, "author = ?")
			args = append(args, truncate(*body.Author, 200))
		}
		if body.Description != nil {
			sets = append(sets, "description = ?")
			args = append(args, truncate(*body.Description, 5000))
		}
		tagsChanged := false
		if body.Tags != nil {
			// 分类标签：去空、去重、单个限长 40、最多 40 个
			seen := map[string]bool{}
			var list []string
			for _, t := range *body.Tags {
				s, ok := t.(string)
				if !ok {
					continue
				}
				s = strings.TrimSpace(truncate(s, 40))
				if s == "" || seen[s] {
					continue
				}
				seen[s] = true
				list = append(list, s)
				if len(list) >= 40 {
					break
				}
			}
			b, _ := json.Marshal(list)
			sets = append(sets, "tags = ?")
			args = append(args, string(b))
			tagsChanged = true
		}
		args = append(args, comicID)
		if _, err := db.Get(e).Prepare("UPDATE comics SET " + strings.Join(sets, ", ") + " WHERE id = ?").Run(args...); err != nil {
			return err
		}
		if tagsChanged {
			lib.InvalidateFacets()
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// POST /api/comics/{comicId}/cover —— 上传自定义封面（multipart，≤10MB）
	mux.HandleFunc("POST /api/comics/{comicId}/cover", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		row := images.GetComicRow(e, comicID)
		if row == nil {
			return lib.NotFound("comic not found")
		}
		buf, err := readUploadedImage(r, 10*1024*1024)
		if err != nil {
			return err
		}
		if buf == nil {
			return lib.BadRequest("cover file required")
		}
		// 母图放 DataDir（清理缓存不会动它）；派生图由 GetCover 按需生成。
		master := images.CustomCoverMasterPath(e, comicID)
		if err := os.MkdirAll(filepath.Dir(master), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(master, buf, 0o644); err != nil {
			return err
		}
		images.ResetCustomCoverCache(e, comicID)
		if _, err := db.Get(e).Prepare("UPDATE comics SET cover_path = ?, meta_locked = 1 WHERE id = ?").Run(master, comicID); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// POST /api/comics/{comicId}/cover-from-page —— 把某一页提成封面（阅读器长按）
	mux.HandleFunc("POST /api/comics/{comicId}/cover-from-page", adapt(func(w http.ResponseWriter, r *http.Request) error {
		comicID := r.PathValue("comicId")
		row := images.GetComicRow(e, comicID)
		if row == nil {
			return lib.NotFound("comic not found")
		}
		var body struct {
			ChapterID string `json:"chapterId"`
			PageIndex *int   `json:"pageIndex"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		pageIndex := 0
		if body.PageIndex != nil && *body.PageIndex > 0 {
			pageIndex = *body.PageIndex
		}
		loc, err := images.ResolveChapter(e, comicID, body.ChapterID)
		if err != nil {
			return err
		}
		if loc == nil {
			return lib.NotFound("chapter not found")
		}
		src, err := sources.OpenSource(loc.ChapterPath, loc.Format, images.SourceOptionsOf(loc))
		if err != nil {
			return err
		}
		// targetWidth：PDF 按封面目标宽渲染，省去「全分辨率渲染再缩小」
		ps, err := src.GetPageStream(pageIndex, sources.PageStreamOptions{
			Quality: sources.QualityOriginal, TargetWidth: 640,
		})
		if err != nil {
			return err
		}
		if ps.Closer != nil {
			defer func() { _ = ps.Closer.Close() }()
		}
		raw, err := io.ReadAll(ps.Stream)
		if err != nil {
			return err
		}
		out, err := images.MakeThumb(raw, 640, images.CoverQuality)
		if err != nil {
			return err
		}
		master := images.CustomCoverMasterPath(e, comicID)
		if err := os.MkdirAll(filepath.Dir(master), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(master, out.Buffer, 0o644); err != nil {
			return err
		}
		images.ResetCustomCoverCache(e, comicID)
		if _, err := db.Get(e).Prepare("UPDATE comics SET cover_path = ?, meta_locked = 1 WHERE id = ?").Run(master, comicID); err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))
}

// fetchByIDs 按 id 批量取整行，并保持传入顺序。
func fetchByIDs(d *db.DB, ids []string) []map[string]any {
	if len(ids) == 0 {
		return nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	rows, err := d.Prepare(comicSelect + " WHERE c.id IN (" + strings.Join(placeholders, ", ") + ")").All(args...)
	if err != nil {
		return nil
	}
	byID := map[string]map[string]any{}
	for _, r := range rows {
		byID[db.AsString(r, "id")] = r
	}
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		if r, ok := byID[id]; ok {
			out = append(out, r)
		}
	}
	return out
}

// ToComicOut DB 行 → 前端契约（camelCase + 聚合态）。
func ToComicOut(row map[string]any) map[string]any {
	out := map[string]any{
		"id":             db.AsString(row, "id"),
		"libraryId":      db.AsString(row, "library_id"),
		"title":          db.AsString(row, "title"),
		"rawTitle":       db.AsString(row, "raw_title"),
		"format":         db.AsString(row, "format"),
		"sizeBytes":      db.AsInt64(row, "size_bytes"),
		"chapterCount":   db.AsInt(row, "chapter_count"),
		"pageCount":      db.AsInt(row, "page_count"),
		"fileModifiedAt": db.AsInt64(row, "file_modified_at"),
		"addedAt":        db.AsInt64(row, "added_at"),
		"isFavorite":     db.AsInt64(row, "is_favorite") != 0,
	}
	if v := db.AsStringPtr(row, "author"); v != nil && *v != "" {
		out["author"] = *v
	}
	if v := db.AsStringPtr(row, "description"); v != nil && *v != "" {
		out["description"] = *v
	}
	var tags []string
	_ = json.Unmarshal([]byte(db.AsString(row, "tags")), &tags)
	if tags == nil {
		tags = []string{}
	}
	out["tags"] = tags
	if db.AsInt64(row, "p_updated_at") != 0 {
		out["progress"] = map[string]any{
			"comicId":      db.AsString(row, "id"),
			"chapterId":    db.AsString(row, "p_chapter_id"),
			"chapterIndex": db.AsInt(row, "p_chapter_index"),
			"pageIndex":    db.AsInt(row, "p_page_index"),
			"pageCount":    db.AsInt(row, "p_page_count"),
			// REAL 列 + 0.1 精度：必须用 AsFloat，AsInt 会把 6.7 截成 6
			"percent":   db.AsFloat(row, "p_percent"),
			"updatedAt": db.AsInt64(row, "p_updated_at"),
		}
		out["lastReadAt"] = db.AsInt64(row, "p_updated_at")
		// finished = 读完**整本书**（停在最后一章且本章到末页），不是读完一章。
		// 以前用 percent>=100 判定，而 percent 曾是章内值 → 读完第 1 章整本书就被
		// 标成已读完（卡片「已读完」角标、详情页按钮退回「开始阅读」）。
		if isBookFinished(
			db.AsInt(row, "p_chapter_index"), db.AsInt(row, "chapter_count"),
			db.AsInt(row, "p_page_index"), db.AsInt(row, "p_page_count"),
		) {
			out["readStatus"] = "finished"
		} else {
			out["readStatus"] = "reading"
		}
	} else {
		out["readStatus"] = "unread"
	}
	return out
}

// countPagesIn 章内页数：folder 型数图片（散图章只数顶层）；压缩包读中央目录。
// readUploadedImage 读 multipart 首个文件字段（限长）。
// 非 multipart 请求返回 (nil, nil)——由调用方按「无文件」处理。
func readUploadedImage(r *http.Request, maxBytes int64) ([]byte, error) {
	ct := r.Header.Get("content-type")
	if !strings.HasPrefix(ct, "multipart/form-data") {
		return nil, nil
	}
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		return nil, lib.BadRequest("invalid multipart")
	}
	boundary, ok := params["boundary"]
	if !ok {
		return nil, lib.BadRequest("missing multipart boundary")
	}
	mr := multipart.NewReader(r.Body, boundary)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return nil, nil
		}
		if err != nil {
			return nil, lib.BadRequest("invalid multipart body")
		}
		if part.FileName() == "" {
			continue
		}
		buf, err := io.ReadAll(io.LimitReader(part, maxBytes+1))
		if err != nil {
			return nil, lib.BadRequest("read upload failed")
		}
		if int64(len(buf)) > maxBytes {
			return nil, lib.BadRequest("file too large")
		}
		return buf, nil
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
