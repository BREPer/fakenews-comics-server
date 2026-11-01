package scanner

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestPageCountOfFolderCaching 验证页数缓存的三个语义：
// 首次计数、二次命中、目录变化（mtime 变）后失效重算。
func TestPageCountOfFolderCaching(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	mk("001.jpg")
	mk("002.jpg")
	mk("003.jpg")
	ClearPageCountCache()

	if n := PageCountOf(dir, "folder", "", false); n != 3 {
		t.Fatalf("首次计数 = %d, want 3", n)
	}
	// 二次调用应命中缓存（结果一致）
	if n := PageCountOf(dir, "folder", "", false); n != 3 {
		t.Fatalf("二次计数 = %d, want 3", n)
	}

	// 新增一页 → 目录 mtime 变化 → 缓存失效
	time.Sleep(20 * time.Millisecond)
	mk("004.jpg")
	if n := PageCountOf(dir, "folder", "", false); n != 4 {
		t.Fatalf("目录变化后计数 = %d, want 4（mtime 失效未生效）", n)
	}
}

// TestPageCountOfMissingDoesNotCache 计数失败（路径不存在）时不写缓存，
// 否则临时不可访问会被永久记住 0 页。
func TestPageCountOfMissingDoesNotCache(t *testing.T) {
	ClearPageCountCache()
	missing := filepath.Join(t.TempDir(), "nope")
	if n := PageCountOf(missing, "folder", "", false); n != 0 {
		t.Fatalf("不存在的目录页数 = %d, want 0", n)
	}
	pageCountCacheMu.Lock()
	_, cached := pageCountCache[missing+"|folder|"]
	pageCountCacheMu.Unlock()
	if cached {
		t.Fatal("计数结果为 0 时不应写缓存")
	}
}

// TestPageCountOfTopOnly topOnly 与普通计数走不同 key，不能互相污染。
func TestPageCountOfTopOnly(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "ch1")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, p := range []string{filepath.Join(root, "top.jpg"), filepath.Join(sub, "a.jpg"), filepath.Join(sub, "b.jpg")} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	ClearPageCountCache()
	if n := PageCountOf(root, "folder", "", true); n != 1 {
		t.Fatalf("topOnly 计数 = %d, want 1", n)
	}
	if n := PageCountOf(root, "folder", "", false); n != 3 {
		t.Fatalf("递归计数 = %d, want 3", n)
	}
}
