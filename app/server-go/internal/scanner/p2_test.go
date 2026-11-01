package scanner

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

// 嵌套库：同一部漫画落在父库与子库两个根下时，归属必须是更具体的子库；
// 源目录 mtime 变化时要通知缓存失效。
func TestNestedLibraryOwnershipAndCacheInvalidation(t *testing.T) {
	root := t.TempDir()
	comicDir := filepath.Join(root, "NestedComic")
	if err := writeImages(comicDir, 2); err != nil {
		t.Fatal(err)
	}
	// 另一部漫画，保证父库的遍历里它不是唯一候选
	if err := writeImages(filepath.Join(root, "Sibling"), 2); err != nil {
		t.Fatal(err)
	}

	dataDir := t.TempDir()
	e := env.Env{
		Port: 0, Host: "127.0.0.1", ComicRoot: root,
		DataDir: dataDir, DBFile: filepath.Join(dataDir, "db", "test.db"),
		CacheDir: filepath.Join(dataDir, "cache"), ThumbCacheMB: 2048, LogLevel: "error",
	}
	d := db.Get(e)
	defer db.ResetSingleton()

	now := time.Now().UnixMilli()
	// 父库 sort 更靠前：旧实现会按遍历顺序把归属永远留给父库
	for _, lib := range []struct {
		id, name, dir string
		sort          int
	}{
		{"lib-parent", "父库", root, 0},
		{"lib-child", "子库", comicDir, 1},
	} {
		if _, err := d.Prepare(
			"INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES (?, ?, 'chapter', ?, ?, ?)",
		).Run(lib.id, lib.name, `["`+filepath.ToSlash(lib.dir)+`"]`, lib.sort, now); err != nil {
			t.Fatalf("insert library: %v", err)
		}
	}

	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("runScan: %v", err)
	}
	row, err := d.Prepare("SELECT id, library_id FROM comics WHERE path = ?").Get(filepath.Clean(comicDir))
	if err != nil || row == nil {
		t.Fatalf("漫画未入库: row=%v err=%v", row, err)
	}
	comicID := db.AsString(row, "id")
	if got := db.AsString(row, "library_id"); got != "lib-child" {
		t.Fatalf("library_id = %q, want lib-child（嵌套库应归属更具体的根）", got)
	}

	// 再扫一次：无变化应跳过，归属不漂移
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("二次 runScan: %v", err)
	}
	row, _ = d.Prepare("SELECT library_id FROM comics WHERE id = ?").Get(comicID)
	if got := db.AsString(row, "library_id"); got != "lib-child" {
		t.Fatalf("二次扫描后 library_id = %q, want lib-child", got)
	}

	var changed []string
	OnSourceChanged = func(id string) { changed = append(changed, id) }
	defer func() { OnSourceChanged = nil }()

	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(comicDir, future, future); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	if err := runScan(e, ScanOptions{}); err != nil {
		t.Fatalf("三次 runScan: %v", err)
	}
	if len(changed) != 1 || changed[0] != comicID {
		t.Fatalf("缓存失效回调 = %v, want [%s]", changed, comicID)
	}
}
