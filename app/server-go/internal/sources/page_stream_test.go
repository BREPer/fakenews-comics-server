package sources

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// writeTestZip 造一个最小 zip/cbz（只含给定条目），避免测试依赖外部夹具。
func writeTestZip(path string, files map[string][]byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	zw := zip.NewWriter(f)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return zw.Close()
}

// TestFolderPageStreamCloser 回归 fd 泄漏：散图文件夹每次取页 os.Open 一个句柄，
// PageStream.Closer 必须非 nil 且真的能关闭（不关就只能等 GC，翻几百页后 EMFILE）。
func TestFolderPageStreamCloser(t *testing.T) {
	dir := t.TempDir()
	const payload = "fake-page-bytes-for-test"
	if err := os.WriteFile(filepath.Join(dir, "001.jpg"), []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := OpenFolder(dir, OpenSourceOptions{})
	if err != nil {
		t.Fatalf("open folder: %v", err)
	}
	pages, err := src.ListPages()
	if err != nil || len(pages) != 1 {
		t.Fatalf("ListPages: %v len=%d", err, len(pages))
	}

	ps, err := src.GetPageStream(0, PageStreamOptions{})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	if ps.Closer == nil {
		t.Fatal("PageStream.Closer 为 nil：句柄不会被释放（fd 泄漏）")
	}

	buf := make([]byte, 4)
	if _, err := io.ReadFull(ps.Stream, buf); err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if err := ps.Closer.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// 关闭后再读必须失败 —— 证明确实关的是这个文件的句柄
	if _, err := ps.Stream.Read(buf); err == nil {
		t.Fatal("Close 之后仍能从 Stream 读到数据，句柄可能没真正关闭")
	}
}

// TestZipPageStreamHasNoCloser zip 走 archive 内部读，不需要调用方关闭。
func TestZipPageStreamHasNoCloser(t *testing.T) {
	// 用一个最小 zip（含一张图）构造，避免依赖外部夹具
	dir := t.TempDir()
	zp := filepath.Join(dir, "a.cbz")
	if err := writeTestZip(zp, map[string][]byte{"001.jpg": []byte("x")}); err != nil {
		t.Skipf("无法构造 zip 夹具: %v", err)
	}
	src, err := OpenZip(zp, "cbz", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip: %v", err)
	}
	// zip.ReadCloser 持有文件句柄：Windows 上不关会导致 t.TempDir 清理失败
	defer src.Close()
	ps, err := src.GetPageStream(0, PageStreamOptions{})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	if ps.Closer != nil {
		t.Fatalf("zip 源不应要求调用方关闭（Closer 非 nil）")
	}
}
