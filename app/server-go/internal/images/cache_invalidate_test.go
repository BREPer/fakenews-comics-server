package images

import (
	"os"
	"path/filepath"
	"testing"

	"fakenews-comics/internal/env"
)

// InvalidateComicCache 只丢派生缓存，用户自定义封面（母图/派生）必须保留。
func TestInvalidateComicCache(t *testing.T) {
	cache := t.TempDir()
	e := env.Env{CacheDir: cache, DataDir: t.TempDir()}
	const comicID = "c1"

	thumb := filepath.Join(cache, "thumbs", comicID, comicID+"#0", "0_320.jpg")
	cover := filepath.Join(cache, "covers", comicID, "320.jpg")
	custom := filepath.Join(cache, "covers-custom", comicID, "320.jpg")
	for _, p := range []string{thumb, cover, custom} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	MemClear()
	defer MemClear()
	MemSet(thumb, []byte("thumb"))
	MemSet(cover, []byte("cover"))
	MemSet(custom, []byte("custom"))

	InvalidateComicCache(e, comicID)

	for _, p := range []string{thumb, cover} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s 应已删除，stat err=%v", p, err)
		}
		if _, ok := MemGet(p); ok {
			t.Errorf("%s 的内存缓存应已清掉", p)
		}
	}
	if _, err := os.Stat(custom); err != nil {
		t.Errorf("自定义封面派生图不应被删: %v", err)
	}
	if _, ok := MemGet(custom); !ok {
		t.Error("自定义封面的内存缓存不应被清")
	}
}
