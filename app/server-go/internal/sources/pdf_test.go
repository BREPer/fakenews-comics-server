package sources

import (
	"bytes"
	"image"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// pdfTestdata 仓内自带的 PDF 样本（随 go-pdfium vendor 进来，无外部资源依赖）。
const pdfTestdata = "testdata/test.pdf"

// 打开测试样本应成功且页数 > 0。
func TestOpenPdf(t *testing.T) {
	src, err := OpenPdf(pdfTestdata)
	if err != nil {
		t.Fatalf("OpenPdf: %v", err)
	}
	defer src.Close()
	if src.NumPages() <= 0 {
		t.Fatalf("NumPages = %d, want > 0", src.NumPages())
	}
	t.Logf("test.pdf has %d pages", src.NumPages())
}

// 渲染第 0 页：目标宽度 → JPEG 字节可解码、宽度不超过目标。
func TestRenderPageThumb(t *testing.T) {
	src, err := OpenPdf(pdfTestdata)
	if err != nil {
		t.Fatalf("OpenPdf: %v", err)
	}
	defer src.Close()

	buf, err := src.GetPageImage(0, 320)
	if err != nil {
		t.Fatalf("GetPageImage: %v", err)
	}
	if len(buf) == 0 {
		t.Fatal("渲染结果为空")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("JPEG 解码失败: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("格式 = %s, want jpeg", format)
	}
	if cfg.Width > 320 {
		t.Fatalf("宽度 %d > 目标 320", cfg.Width)
	}
	t.Logf("缩略图渲染: %d×%d, %d bytes", cfg.Width, cfg.Height, len(buf))
}

// 原图模式：LRU 命中（两次渲染字节一致）+ 尺寸大于缩略图。
func TestRenderPageOriginal(t *testing.T) {
	src, err := OpenPdf(pdfTestdata)
	if err != nil {
		t.Fatalf("OpenPdf: %v", err)
	}
	defer src.Close()

	a, err := src.GetPageImage(0, 0)
	if err != nil {
		t.Fatalf("原图渲染: %v", err)
	}
	b, err := src.GetPageImage(0, 0)
	if err != nil {
		t.Fatalf("原图渲染(缓存): %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("LRU 未命中：两次原图渲染字节不一致")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(a))
	if err != nil {
		t.Fatalf("JPEG 解码失败: %v", err)
	}
	t.Logf("原图渲染: %d×%d, %d bytes", cfg.Width, cfg.Height, len(a))
}

// 越界页索引应报 ErrPageOutOfRange。
func TestRenderPageOutOfRange(t *testing.T) {
	src, err := OpenPdf(pdfTestdata)
	if err != nil {
		t.Fatalf("OpenPdf: %v", err)
	}
	defer src.Close()
	if _, err := src.GetPageImage(src.NumPages(), 320); err == nil {
		t.Fatal("越界页索引应报错")
	}
}

// 并发打开多个 PDF（详情页 mapLimit 回填场景）：单 WASM 实例上多文档并发。
func TestPdfConcurrentOpen(t *testing.T) {
	root := filepath.Join(os.TempDir(), "fc-chapter-lib")
	var paths []string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(strings.ToLower(p), ".pdf") {
			paths = append(paths, p)
		}
		return nil
	})
	if len(paths) < 1 {
		t.Skipf("夹具 PDF 不足 3 个（%d），跳过并发复现", len(paths))
	}
	// 复制到 6 个路径保证并发量
	var all []string
	for i := 0; i < 6; i++ {
		all = append(all, paths[i%len(paths)])
	}
	t.Logf("concurrent open %d PDF docs", len(all))
	errs := make([]error, len(all))
	var wg sync.WaitGroup
	for i, p := range all {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			src, err := OpenPdf(p)
			if err != nil {
				errs[i] = err
				return
			}
			defer src.Close()
			_, errs[i] = src.GetPageImage(0, 320)
		}(i, p)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Errorf("%s: %v", filepath.Base(all[i]), e)
		}
	}
}
