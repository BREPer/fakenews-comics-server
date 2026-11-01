// libraries 路由：漫画库 CRUD + 排序。
// 新建/编辑库时立即触发一次扫描。
// libraries 路由（库 CRUD / 排序 / 目录浏览）。
package routes

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/scanner"
	"fakenews-comics/internal/sources"
)

// isPathAccessible 目录是否可访问（存在且可读）。卷未挂载 / fnOS 未授权时返回 false。
func isPathAccessible(p string) bool {
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		return false
	}
	if _, err := os.ReadDir(p); err != nil { // 仅 stat 可能被挂载点伪造，真正读一次才可靠
		return false
	}
	return true
}

func inaccessiblePathsOf(paths []string) []string {
	var out []string
	for _, p := range paths {
		if !isPathAccessible(p) {
			out = append(out, p)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// folderHasComicContent 目录是否"本身就是一部漫画"：直接含图（≥1 张非样张图）
// 或顶层有压缩包。判定与扫描器 promote 语义同源（FolderHasImages / TopArchivesOf），
// browse 接口拿它给 leafHint —— 提示用户「这一层选了只收录这一部」。
// 判不了（不可读）时返回 false，不影响可选性。
func folderHasComicContent(dir string) bool {
	if scanner.FolderHasImages(dir) {
		return true
	}
	return len(scanner.TopArchivesOf(dir)) > 0
}

func registerLibraries(mux *http.ServeMux, e env.Env) {
	// GET /api/libraries/browse?path=… —— 浏览挂载根下的子目录（库路径点选器用）。
	//
	// 为什么做这个：库路径手输是错的温床——容器内恒定只见 /comics，用户却拿着
	// 飞牛的宿主机路径（/vol1/...）来填，扫描后书架为空还要排查半天。点选从
	// ComicRoot 起步，给出来的路径天然可访问，整类错误在 UI 层消失。
	//
	// 契约：
	//   path 缺省 = ComicRoot；只返回**子目录**（不含文件），隐藏/NAS 元数据目录
	//   （sources.SkipDirName：.开头 / @eaDir / #回收站# / __MACOSX）不列——
	//   与扫描器的跳过规则同源，选了就能扫出东西。
	//   每项带 leafHint：该目录直接含图或顶层压缩包（扫描器语义下"本身就是一部
	//   漫画"），UI 用它提示「选这层会只收录这一部，选上层才能整片收录」。
	//   出错回 404 信封（目录不可读 = fnOS 未授权/卷未挂载，message 直接给人看）。
	mux.HandleFunc("GET /api/libraries/browse", adapt(func(w http.ResponseWriter, r *http.Request) error {
		root := filepath.ToSlash(filepath.Clean(e.ComicRoot))
		q := strings.TrimSpace(r.URL.Query().Get("path"))
		dir := root
		if q != "" {
			// 相对路径按根内解析；绝对路径必须在根内。Clean 先行，防 ".." 越权：
			// /comics/../etc 前缀匹配不过 root，直接拒绝。
			if !filepath.IsAbs(q) && !strings.HasPrefix(q, "/") {
				q = root + "/" + q
			}
			cand := filepath.ToSlash(filepath.Clean(q))
			if cand != root && !strings.HasPrefix(cand, root+"/") {
				return lib.NotFound("path outside comic root")
			}
			dir = cand
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			// 典型：fnOS 未勾「允许 Docker 容器访问」、卷未挂载、路径被删。
			return lib.NotFound("目录不可读：" + dir)
		}
		type entry struct {
			Name     string `json:"name"`
			Path     string `json:"path"`
			LeafHint bool   `json:"leafHint"`
		}
		items := make([]entry, 0, len(entries))
		for _, en := range entries {
			if !en.IsDir() || sources.SkipDirName(en.Name()) {
				continue
			}
			p := dir + "/" + en.Name()
			items = append(items, entry{
				Name:     en.Name(),
				Path:     p,
				LeafHint: folderHasComicContent(p),
			})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
		httputil.WriteData(w, map[string]any{
			"path": dir,
			"root": root,
			// 根本身是否"可收录"（整个挂载点就是一部漫画的罕见形态）
			"leafHint": folderHasComicContent(dir),
			"items":    items,
		})
		return nil
	}))

	// GET /api/libraries —— 列表（含漫画计数 + 不可访问路径诊断）
	mux.HandleFunc("GET /api/libraries", adapt(func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.Get(e).Prepare(`
      SELECT l.*, (SELECT COUNT(*) FROM comics c WHERE c.library_id = l.id) AS comic_count
      FROM libraries l ORDER BY l.sort, l.created_at
    `).All()
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			var paths []string
			_ = json.Unmarshal([]byte(db.AsString(row, "paths")), &paths)
			if paths == nil {
				paths = []string{}
			}
			items = append(items, map[string]any{
				"id":                db.AsString(row, "id"),
				"name":              db.AsString(row, "name"),
				"type":              db.AsString(row, "type"),
				"paths":             paths,
				"sort":              db.AsInt(row, "sort"),
				"createdAt":         db.AsInt64(row, "created_at"),
				"comicCount":        db.AsInt64(row, "comic_count"),
				"inaccessiblePaths": inaccessiblePathsOf(paths),
			})
		}
		httputil.WriteData(w, map[string]any{"items": items})
		return nil
	}))

	// POST /api/libraries —— 新建
	mux.HandleFunc("POST /api/libraries", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			Name  *string  `json:"name"`
			Type  string   `json:"type"`
			Paths []string `json:"paths"`
		}
		if err := httputil.DecodeJSON(r, &b); err != nil {
			return lib.BadRequest("invalid json body")
		}
		name, err := lib.NeedString(deref(b.Name), "name", 100)
		if err != nil {
			return err
		}
		typ := "chapter"
		if b.Type == "single" {
			typ = "single"
		}
		var paths []string
		for _, p := range b.Paths {
			if p != "" {
				paths = append(paths, p)
			}
		}
		if len(paths) == 0 {
			return lib.BadRequest("paths required")
		}
		pj, _ := json.Marshal(paths)
		id := newUUID()
		d := db.Get(e)
		maxRow, _ := d.Prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM libraries").Get()
		maxSort := db.AsInt64(maxRow, "m")
		if _, err := d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)").
			Run(id, name, typ, string(pj), maxSort+1, time.Now().UnixMilli()); err != nil {
			return err
		}
		scanner.TriggerScan(e, scanner.ScanOptions{LibraryID: id})
		httputil.WriteData(w, map[string]any{"id": id})
		return nil
	}))

	// PATCH /api/libraries/{id} —— 编辑
	mux.HandleFunc("PATCH /api/libraries/{id}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		d := db.Get(e)
		row, _ := d.Prepare("SELECT * FROM libraries WHERE id = ?").Get(id)
		if row == nil {
			return lib.NotFound("library not found")
		}
		var b struct {
			Name  *string  `json:"name"`
			Type  *string  `json:"type"`
			Paths []string `json:"paths"`
		}
		if err := httputil.DecodeJSON(r, &b); err != nil {
			return lib.BadRequest("invalid json body")
		}
		var sets []string
		var args []any
		if b.Name != nil {
			name, err := lib.NeedString(*b.Name, "name", 100)
			if err != nil {
				return err
			}
			sets = append(sets, "name = ?")
			args = append(args, name)
		}
		if b.Type != nil {
			typ := "chapter"
			if *b.Type == "single" {
				typ = "single"
			}
			sets = append(sets, "type = ?")
			args = append(args, typ)
		}
		if b.Paths != nil {
			var paths []string
			for _, p := range b.Paths {
				if p != "" {
					paths = append(paths, p)
				}
			}
			if len(paths) == 0 {
				return lib.BadRequest("paths required")
			}
			pj, _ := json.Marshal(paths)
			sets = append(sets, "paths = ?")
			args = append(args, string(pj))
		}
		if len(sets) > 0 {
			args = append(args, id)
			if _, err := d.Prepare("UPDATE libraries SET "+joinComma2(sets)+" WHERE id = ?").Run(args...); err != nil {
				return err
			}
		}
		scanner.TriggerScan(e, scanner.ScanOptions{LibraryID: id})
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// DELETE /api/libraries/{id} —— 删除（级联清漫画/进度/收藏/分章标记）
	mux.HandleFunc("DELETE /api/libraries/{id}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		d := db.Get(e)
		row, _ := d.Prepare("SELECT id FROM libraries WHERE id = ?").Get(id)
		if row == nil {
			return lib.NotFound("library not found")
		}
		// 先清无外键的关联表，再显式删 comics，最后删库。
		// 不依赖 PRAGMA foreign_keys 的 ON DELETE CASCADE（容器/不同 SQLite 构建下可能不生效）。
		comicRows, _ := d.Prepare("SELECT id FROM comics WHERE library_id = ?").All(id)
		err := d.Tx(func(tx *db.Tx) error {
			cleanProgress := tx.Prepare("DELETE FROM reading_progress WHERE comic_id = ?")
			cleanFav := tx.Prepare("DELETE FROM favorites WHERE comic_id = ?")
			dropComic := tx.Prepare("DELETE FROM comics WHERE id = ?")
			for _, c := range comicRows {
				cid := db.AsString(c, "id")
				if _, err := cleanProgress.Run(cid); err != nil {
					return err
				}
				if _, err := cleanFav.Run(cid); err != nil {
					return err
				}
				if _, err := dropComic.Run(cid); err != nil {
					return err
				}
			}
			if _, err := tx.Prepare("DELETE FROM comics WHERE library_id = ?").Run(id); err != nil {
				return err
			}
			_, err := tx.Prepare("DELETE FROM libraries WHERE id = ?").Run(id)
			return err
		})
		if err != nil {
			return err
		}
		lib.InvalidateFacets()
		httputil.WriteData(w, map[string]any{"ok": true, "removedComics": len(comicRows)})
		return nil
	}))

	// POST /api/libraries/reorder —— 拖拽排序 { ids: [...] }
	mux.HandleFunc("POST /api/libraries/reorder", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			IDs []string `json:"ids"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		if body.IDs == nil {
			return lib.BadRequest("ids required")
		}
		d := db.Get(e)
		return d.Tx(func(tx *db.Tx) error {
			stmt := tx.Prepare("UPDATE libraries SET sort = ? WHERE id = ?")
			for i, id := range body.IDs {
				if _, err := stmt.Run(i, id); err != nil {
					return err
				}
			}
			return nil
		})
	}))
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b[0:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" +
		hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" + hex.EncodeToString(b[10:16])
}

func joinComma2(parts []string) string {
	return joinComma(parts)
}
