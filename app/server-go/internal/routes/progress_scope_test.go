// 进度记录边界：只写「当前正在阅读的章节」（reading_progress），
// 不得存在/写入任何非当前章的进度数据（chapter_progress 已整体移除）。
package routes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

// progressTestEnv 起一套带临时 DB 的路由（只注册进度/备份相关，够用）。
func progressTestEnv(t *testing.T) (*httptest.Server, env.Env) {
	t.Helper()
	dir := t.TempDir()
	db.ResetSingleton()
	t.Cleanup(db.ResetSingleton)
	e := env.Env{
		DataDir:  dir,
		DBFile:   filepath.Join(dir, "db", "progress.db"),
		CacheDir: filepath.Join(dir, "cache"),
		ComicRoot: dir,
	}
	d := db.Get(e)
	// 注册要求 comic 存在（PUT /api/progress 会校验）
	d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES ('lib-1','测试库','single','[]',0,1)").Run()
	d.Prepare("INSERT INTO comics (id, library_id, title, raw_title, format, path, size_bytes, chapter_count, page_count, tags, file_modified_at, added_at, meta_locked) VALUES ('c1','lib-1','漫画一','漫画一','folder','/x/c1',0,3,30,'[]',1,1,0)").Run()

	mux := http.NewServeMux()
	Register(mux, e)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, e
}

/** 取列表接口里某部漫画的 readStatus / progress（走真实 SQL，含 ToComicOut） */
func comicRow(t *testing.T, e env.Env, comicID string) map[string]any {
	t.Helper()
	rows, err := db.Get(e).Prepare(`
    SELECT c.*, p.chapter_id AS p_chapter_id, p.chapter_index AS p_chapter_index,
           p.page_index AS p_page_index, p.page_count AS p_page_count,
           p.percent AS p_percent, p.updated_at AS p_updated_at
    FROM comics c LEFT JOIN reading_progress p ON p.comic_id = c.id
    WHERE c.id = ?`).All(comicID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("查漫画失败: err=%v rows=%d", err, len(rows))
	}
	out := ToComicOut(rows[0])
	if out["progress"] == nil {
		t.Fatalf("没有进度记录：%+v", out)
	}
	return out
}

func putProgress(t *testing.T, url string, body map[string]any) map[string]any {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPut, url+"/api/progress", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT /api/progress 失败: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Code int            `json:"code"`
		Data map[string]any `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if out.Code != 0 {
		t.Fatalf("PUT /api/progress 业务错误: code=%d", out.Code)
	}
	return out.Data
}

// TestProgressOnlyWritesCurrentChapter 上报进度只落 reading_progress 一行，
// 且 chapter_progress 表已不存在 —— 非当前在读章节没有任何进度数据可写。
func TestProgressOnlyWritesCurrentChapter(t *testing.T) {
	srv, e := progressTestEnv(t)
	putProgress(t, srv.URL, map[string]any{
		"comicId": "c1", "chapterId": "c1#1", "chapterIndex": 1,
		"pageIndex": 5, "pageCount": 30, "percent": 20,
	})

	d := db.Get(e)
	rows, err := d.Prepare("SELECT chapter_id, page_index FROM reading_progress WHERE comic_id = 'c1'").All()
	if err != nil {
		t.Fatalf("读 reading_progress 失败: %v", err)
	}
	if len(rows) != 1 || db.AsString(rows[0], "chapter_id") != "c1#1" || db.AsInt(rows[0], "page_index") != 5 {
		t.Fatalf("reading_progress 内容不对: %+v", rows)
	}

	// chapter_progress 表必须已经不存在（schema 里 DROP 掉了）
	tables, err := d.Prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chapter_progress'").All()
	if err != nil {
		t.Fatalf("查 sqlite_master 失败: %v", err)
	}
	if len(tables) != 0 {
		t.Fatalf("chapter_progress 表仍然存在，非当前章进度数据有地方可写")
	}
	// 直接写这张表应当失败（表不存在），从库层面堵死「非当前章进度」。
	// db.Prepare 遇到 SQL 错误是 panic 而非返回 error，所以用 recover 接。
	func() {
		defer func() {
			if rec := recover(); rec == nil {
				t.Fatal("chapter_progress 还能写入，删除不彻底")
			}
		}()
		d.Prepare("INSERT INTO chapter_progress (comic_id, chapter_id) VALUES ('c1','c1#0')").Run()
	}()
}

// TestChapterIndexOutOfRangeRejected 章节号越界直接报错，不静默修正。
func TestChapterIndexOutOfRangeRejected(t *testing.T) {
	srv, _ := progressTestEnv(t)
	buf, _ := json.Marshal(map[string]any{
		"comicId": "c1", "chapterId": "c1#9", "chapterIndex": 9,
		"pageIndex": 1, "pageCount": 10,
	})
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/progress", bytes.NewReader(buf))
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Code int `json:"code"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Code == 0 {
		t.Fatal("chapterIndex=9（全书 3 章）被接受了，越界校验没生效")
	}
}

// TestBookPercentAcrossChapters 全书 percent：前序章页数 + 本章已读页 / 全书页数。
//
// 回归背景：percent 以前直接存前端传的**章内**百分比，读完多章漫画的第 1 章就是
// 100%，而 readStatus 用 percent>=100 判读完 → 整本书被误标已读完。
func TestBookPercentAcrossChapters(t *testing.T) {
	// 造一部 2 章漫画：ch1 4 页、ch2 6 页（共 10 页）
	root := t.TempDir()
	comicDir := filepath.Join(root, "书")
	for name, n := range map[string]int{"ch1": 4, "ch2": 6} {
		dir := filepath.Join(comicDir, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < n; i++ {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%03d.jpg", i)), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	dir := t.TempDir()
	db.ResetSingleton()
	t.Cleanup(db.ResetSingleton)
	e := env.Env{
		DataDir:   dir,
		DBFile:    filepath.Join(dir, "db", "progress.db"),
		CacheDir:  filepath.Join(dir, "cache"),
		ComicRoot: root,
	}
	d := db.Get(e)
	d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES ('lib-1','测试库','chapter','[]',0,1)").Run()
	d.Prepare(`INSERT INTO comics (id, library_id, title, raw_title, format, path, size_bytes, chapter_count,
		page_count, tags, file_modified_at, added_at, meta_locked)
		VALUES ('bk','lib-1','书','书','folder',?,0,2,10,'[]',1,1,0)`).Run(comicDir)

	mux := http.NewServeMux()
	Register(mux, e)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// ① 读完第 1 章（4/4）：全书 40%，不是 100%，也不是 finished
	data := putProgress(t, srv.URL, map[string]any{
		"comicId": "bk", "chapterId": "bk#0", "chapterIndex": 0,
		"pageIndex": 3, "pageCount": 4, "percent": 100,
	})
	if got := data["percent"].(float64); got < 39.9 || got > 40.1 {
		t.Fatalf("读完第 1 章应是全书 40%%，实际 %v", got)
	}
	row := comicRow(t, e, "bk")
	if row["readStatus"] == "finished" {
		t.Fatal("只读完第 1 章就被标成 finished")
	}

	// ② 读完第 2 章（6/6）：全书 100% 且 finished
	putProgress(t, srv.URL, map[string]any{
		"comicId": "bk", "chapterId": "bk#1", "chapterIndex": 1,
		"pageIndex": 5, "pageCount": 6, "percent": 100,
	})
	row = comicRow(t, e, "bk")
	if p := row["progress"].(map[string]any)["percent"].(float64); p != 100 {
		t.Fatalf("读完全书应是 100%%，实际 %v", p)
	}
	if row["readStatus"] != "finished" {
		t.Fatalf("读完最后一章应是 finished，实际 %v", row["readStatus"])
	}
}

// TestIsBookFinished 读完判定：只有「停在最后一章且本章到末页」才算读完整本。
func TestIsBookFinished(t *testing.T) {
	cases := []struct {
		name                                  string
		chapterIndex, chapterCount, page, cnt int
		want                                  bool
	}{
		{"多章只读完第 1 章", 0, 3, 29, 30, false},
		{"多章读完最后一章", 2, 3, 29, 30, true},
		{"最后一章差一页", 2, 3, 28, 30, false},
		{"单篇读完", 0, 1, 19, 20, true},
		{"单篇差一页", 0, 1, 18, 20, false},
		{"章数为 0（扫描未完成）", 0, 0, 19, 20, false},
	}
	for _, c := range cases {
		if got := isBookFinished(c.chapterIndex, c.chapterCount, c.page, c.cnt); got != c.want {
			t.Errorf("%s: isBookFinished(%d,%d,%d,%d)=%v，期望 %v",
				c.name, c.chapterIndex, c.chapterCount, c.page, c.cnt, got, c.want)
		}
	}
}

// TestBackupExportHasNoChapterProgress 导出/导入不再携带分章进度；
// 老备份文件里残留的 chapterProgress 字段被忽略而不是报错。
func TestBackupExportHasNoChapterProgress(t *testing.T) {
	srv, e := progressTestEnv(t)
	putProgress(t, srv.URL, map[string]any{
		"comicId": "c1", "chapterId": "c1#2", "chapterIndex": 2,
		"pageIndex": 9, "pageCount": 30, "percent": 33,
	})

	resp, err := http.Get(srv.URL + "/api/backup/export")
	if err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Code int `json:"code"`
		Data struct {
			Progress []map[string]any `json:"progress"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("解析导出失败: %v", err)
	}
	if len(out.Data.Progress) != 1 {
		t.Fatalf("导出进度条数不对: %d", len(out.Data.Progress))
	}

	// 导入一份「老格式」备份（带 chapterProgress）：必须成功且忽略该字段
	old := `{"version":1,"progress":[{"comicId":"c1","chapterId":"c1#1","chapterIndex":1,"pageIndex":3,"pageCount":30,"percent":10,"updatedAt":2}],
	         "chapterProgress":[{"comicId":"c1","chapterId":"c1#0","pageIndex":2,"pageCount":30,"percent":7,"updatedAt":2}]}`
	imp, err := http.Post(srv.URL+"/api/backup/import", "application/json", strings.NewReader(old))
	if err != nil {
		t.Fatalf("导入失败: %v", err)
	}
	defer imp.Body.Close()
	var iout struct {
		Code int `json:"code"`
		Data struct {
			Imported map[string]int `json:"imported"`
		} `json:"data"`
	}
	if err := json.NewDecoder(imp.Body).Decode(&iout); err != nil {
		t.Fatalf("解析导入失败: %v", err)
	}
	if iout.Code != 0 {
		t.Fatalf("导入业务错误: code=%d", iout.Code)
	}
	if _, ok := iout.Data.Imported["chapterProgress"]; ok {
		t.Fatal("导入结果里还有 chapterProgress 计数")
	}
	if iout.Data.Imported["progress"] != 1 {
		t.Fatalf("导入进度条数不对: %+v", iout.Data.Imported)
	}

	// updatedAt=2 早于库里现值（刚上报的 now），合并语义下不应覆盖当前章
	d := db.Get(e)
	rows, err := d.Prepare("SELECT chapter_id, page_index FROM reading_progress WHERE comic_id = 'c1'").All()
	if err != nil {
		t.Fatalf("读 reading_progress 失败: %v", err)
	}
	if len(rows) != 1 || db.AsString(rows[0], "chapter_id") != "c1#2" {
		t.Fatalf("旧备份把当前章覆盖掉了: %+v", rows)
	}
}
