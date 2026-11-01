package scanner

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

// 全链路：建库 → 扫描 → 断言 comics 表 → 增量再扫 → 删除级联。
// db 是进程单例，本测试只用一次（同一 env）。
func TestRunScanFullCycle(t *testing.T) {
	root := fixture(t)
	dataDir := t.TempDir()
	e := env.Env{
		Port: 0, Host: "127.0.0.1", ComicRoot: root,
		DataDir: dataDir, DBFile: filepath.Join(dataDir, "db", "test.db"),
		CacheDir: filepath.Join(dataDir, "cache"), ThumbCacheMB: 2048, LogLevel: "error",
	}
	d := db.Get(e)
	defer db.ResetSingleton()

	// 建库（章节型）
	libID := "lib-test-1"
	d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES (?, ?, ?, ?, 0, ?)").
		Run(libID, "测试库", "chapter", `["`+filepath.ToSlash(root)+`"]`, time.Now().UnixMilli())

	// 首扫
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("runScan: %v", err)
	}
	rows, err := d.Prepare("SELECT id, title, format, chapter_count, page_count, path FROM comics ORDER BY path").All()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 8 {
		t.Fatalf(" comics 条数 = %d, want 8", len(rows))
	}
	for _, r := range rows {
		t.Logf("  %s | %s | 章=%d 页=%d", db.AsString(r, "path"), db.AsString(r, "format"),
			db.AsInt(r, "chapter_count"), db.AsInt(r, "page_count"))
	}

	// 抽两条断言章节模型
	byPath := map[string]map[string]any{}
	for _, r := range rows {
		byPath[db.AsString(r, "path")] = r
	}
	gl := byPath[filepath.Join(root, "格林童话")]
	if gl == nil || db.AsInt(gl, "chapter_count") != 2 {
		t.Fatalf("格林童话 chapter_count = %v, want 2", gl)
	}
	if db.AsInt(gl, "page_count") == 0 {
		t.Fatal("格林童话 page_count = 0")
	}
	// 混合结构：3 章
	mix := byPath[filepath.Join(root, "混合结构")]
	if mix == nil || db.AsInt(mix, "chapter_count") != 3 {
		t.Fatalf("混合结构 chapter_count = %v, want 3", mix)
	}
	// cbz：包内分组
	cbz := byPath[filepath.Join(root, "刮削测试.cbz")]
	if cbz == nil || db.AsInt(cbz, "chapter_count") < 2 {
		t.Fatalf("刮削测试.cbz chapter_count = %v, want ≥2", cbz)
	}
	// META_VERSION 已记账
	if v := readMetaVersion(d); v != META_VERSION {
		t.Fatalf("META_VERSION = %d, want %d", v, META_VERSION)
	}

	// 增量再扫：全部跳过
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("二次 runScan: %v", err)
	}
	st := GetScanStatus()
	if st.Skipped != st.Total || st.Total != 8 {
		t.Fatalf("增量扫描 skipped=%d total=%d, want 8/8", st.Skipped, st.Total)
	}
	n2, _ := d.Prepare("SELECT COUNT(*) AS n FROM comics").Get()
	if db.AsInt(n2, "n") != 8 {
		t.Fatalf("二次扫描后条数 = %d, want 8", db.AsInt(n2, "n"))
	}

	// 删除级联：移走一部 → 再扫 → 条目消失
	glPath := filepath.Join(root, "格林童话")
	// 移到库根【外】：改名但仍在库根内会被当成新漫画插入（path 唯一键，移动即新书，与 TS 一致）
	backup := filepath.Join(t.TempDir(), "格林童话-moved")
	if err := os.Rename(glPath, backup); err != nil {
		t.Fatal(err)
	}
	defer os.Rename(backup, glPath)
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("三次 runScan: %v", err)
	}
	gone, _ := d.Prepare("SELECT COUNT(*) AS n FROM comics WHERE path = ?").Get(glPath)
	if db.AsInt(gone, "n") != 0 {
		t.Fatal("删除的漫画未被级联清理")
	}
	left, _ := d.Prepare("SELECT COUNT(*) AS n FROM comics").Get()
	if db.AsInt(left, "n") != 7 {
		t.Fatalf("剩余 = %d, want 7", db.AsInt(left, "n"))
	}
}

// ComicInfo 元数据进库（刮削目录）。
func TestRunScanComicInfoMetadata(t *testing.T) {
	root := fx(t, "刮削目录")
	dataDir := t.TempDir()
	e := env.Env{
		ComicRoot: filepath.Dir(root), DataDir: dataDir,
		DBFile: filepath.Join(dataDir, "db", "test.db"), CacheDir: filepath.Join(dataDir, "cache"),
		ThumbCacheMB: 2048, LogLevel: "error",
	}
	db.ResetSingleton()
	d := db.Get(e)
	defer db.ResetSingleton()
	d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES (?, ?, ?, ?, 0, ?)").
		Run("lib-ci", "刮削库", "chapter", `["`+filepath.ToSlash(filepath.Dir(root))+`"]`, time.Now().UnixMilli())
	// 只扫这一部：临时把库根指到刮削目录本身不行（会整册扫），
	// 直接全量扫后过滤断言（夹具只有 8 部，开销可忽略）
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatal(err)
	}
	row, _ := d.Prepare("SELECT title, author, description, tags FROM comics WHERE path LIKE ?").
		Get("%刮削目录%")
	if row == nil {
		t.Fatal("刮削目录未入库")
	}
	t.Logf("刮削目录: title=%q author=%q tags=%s", db.AsString(row, "title"),
		db.AsString(row, "author"), db.AsString(row, "tags"))
	if db.AsString(row, "author") == "" {
		t.Error("ComicInfo 的 Writer 未写入 author")
	}
}
