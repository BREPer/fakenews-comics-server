package sources

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeTar 在测试里现场造一个 tar（含 ComicInfo 与包内分章目录）。
func makeTar(t *testing.T, files map[string][]byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fixture.tar")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(f)
	// 固定顺序写，保证文件内条目顺序确定
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	// 简单插入排序，避免引入 sort 依赖的额外导入差异
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	for _, k := range keys {
		h := &tar.Header{Name: k, Mode: 0o644, Size: int64(len(files[k])), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(files[k]); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

// pngBytes 造一张可区分的 PNG（不同页不同尺寸/内容，便于校验字节级正确）。
func pngBytes(t *testing.T, w, h int, seed byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	buf.WriteByte(seed)
	// 至少 256 字节：Range 断言要切 0..100 与 5..20 两段
	for i := 0; i < 256+w*h/50; i++ {
		buf.WriteByte(seed + byte(i%7))
	}
	return buf.Bytes()
}

func TestTarSourcePagesAndRange(t *testing.T) {
	page10 := pngBytes(t, 40, 60, 'A')
	page11 := pngBytes(t, 60, 40, 'B')
	p := makeTar(t, map[string][]byte{
		"第01卷/010.png": page10,
		"第01卷/011.png": page11,
		"第02卷/020.png": pngBytes(t, 30, 30, 'C'),
	})
	src, err := OpenTar(p, "cbt", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenTar: %v", err)
	}
	defer src.Close()

	if src.Format() != "cbt" {
		t.Fatalf("Format() = %q, want cbt", src.Format())
	}

	pages, err := src.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	if len(pages) != 3 {
		t.Fatalf("页数 = %d, want 3", len(pages))
	}
	// 自然排序：第01卷/010 < 第01卷/011 < 第02卷/020
	wantOrder := []string{"第01卷/010.png", "第01卷/011.png", "第02卷/020.png"}
	for i, w := range wantOrder {
		if pages[i].Path != w {
			t.Fatalf("第 %d 页 = %q, want %q", i, pages[i].Path, w)
		}
	}
	// Size 必须来自 tar 头（Range 边界依赖它）
	if pages[0].Size != int64(len(page10)) {
		t.Fatalf("首页 size = %d, want %d", pages[0].Size, len(page10))
	}

	// 整读
	st, err := src.GetPageStream(0, PageStreamOptions{})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	all, err := io.ReadAll(st.Stream)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(all, page10) {
		t.Fatalf("整读字节不一致（len=%d want=%d）", len(all), len(page10))
	}

	// Range：前 100 字节
	st, err = src.GetPageStream(0, PageStreamOptions{Start: 0, Length: 100})
	if err != nil {
		t.Fatalf("GetPageStream range: %v", err)
	}
	head, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(head, page10[:100]) {
		t.Fatal("Range 前 100 字节不一致")
	}

	// Range：中段（这里样本很小，取 5..20）
	st, err = src.GetPageStream(0, PageStreamOptions{Start: 5, Length: 15})
	if err != nil {
		t.Fatalf("GetPageStream mid: %v", err)
	}
	mid, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(mid, page10[5:20]) {
		t.Fatalf("Range 中段字节不一致: %x", mid)
	}

	// 越界
	if _, err := src.GetPageStream(3, PageStreamOptions{}); err != ErrPageOutOfRange {
		t.Fatalf("越界应返回 ErrPageOutOfRange, got %v", err)
	}
}

func TestTarSourceChaptersAndPrefix(t *testing.T) {
	p := makeTar(t, map[string][]byte{
		"第01卷/010.png": pngBytes(t, 10, 10, 'A'),
		"第01卷/011.png": pngBytes(t, 10, 10, 'B'),
		"第02卷/020.png": pngBytes(t, 10, 10, 'C'),
		"第10卷/100.png": pngBytes(t, 10, 10, 'D'),
	})
	src, err := OpenTar(p, "tar", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenTar: %v", err)
	}
	defer src.Close()

	chapters, err := src.ListChapters()
	if err != nil {
		t.Fatalf("ListChapters: %v", err)
	}
	if len(chapters) != 3 {
		t.Fatalf("章数 = %d, want 3", len(chapters))
	}
	// 数值序：第01卷 < 第02卷 < 第10卷
	if chapters[2].ID != "第10卷" {
		t.Fatalf("第三章 = %q, want 第10卷（数值序）", chapters[2].ID)
	}

	// prefix 章视图：只列该目录下
	view, err := OpenTar(p, "tar", OpenSourceOptions{Prefix: "第02卷"})
	if err != nil {
		t.Fatalf("OpenTar prefix: %v", err)
	}
	defer view.Close()
	pages, err := view.ListPages()
	if err != nil {
		t.Fatalf("ListPages prefix: %v", err)
	}
	if len(pages) != 1 || pages[0].Path != "第02卷/020.png" {
		t.Fatalf("prefix 视图页清单 = %+v", pages)
	}
	// prefix 视图不再分章
	if ch, _ := view.ListChapters(); len(ch) != 0 {
		t.Fatalf("prefix 视图不应再有章: %+v", ch)
	}
}

func TestTarSourceComicInfo(t *testing.T) {
	xml := `<ComicInfo><Title>测试本</Title><Writer>作者甲</Writer><Genre>悬疑</Genre></ComicInfo>`
	p := makeTar(t, map[string][]byte{
		"ComicInfo.xml": []byte(xml),
		"001.png":       pngBytes(t, 10, 10, 'A'),
	})
	src, err := OpenTar(p, "tar", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenTar: %v", err)
	}
	defer src.Close()

	// ComicInfo 不能算成页
	pages, _ := src.ListPages()
	if len(pages) != 1 {
		t.Fatalf("页数 = %d, want 1（ComicInfo 不应计入）", len(pages))
	}
	meta, err := src.ReadMetadata()
	if err != nil {
		t.Fatalf("ReadMetadata: %v", err)
	}
	if meta == nil || meta.Title != "测试本" || meta.Author != "作者甲" {
		t.Fatalf("元数据 = %+v", meta)
	}
}

func TestOpenSourceTarBadArchive(t *testing.T) {
	// 非 tar 内容 → 415（SourceError），而不是裸错误
	p := filepath.Join(t.TempDir(), "bad.tar")
	if err := os.WriteFile(p, []byte("这不是一个 tar 包"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := OpenSource(p, "tar", OpenSourceOptions{})
	var se *SourceError
	if err == nil {
		t.Fatal("坏包应报错")
	}
	if !asSourceError(err, &se) || se.Status != 415 {
		t.Fatalf("坏包应映射为 415 SourceError, got %v", err)
	}
}

func asSourceError(err error, target **SourceError) bool {
	for err != nil {
		if se, ok := err.(*SourceError); ok {
			*target = se
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// 顺带守住「tar 条目名里的前导 ./ 被规整」这个细节（不同打包工具产出不一致）。
func TestTarEntryNameCleanup(t *testing.T) {
	p := filepath.Join(t.TempDir(), "dot.tar")
	f, _ := os.Create(p)
	tw := tar.NewWriter(f)
	_ = tw.WriteHeader(&tar.Header{Name: "./001.png", Mode: 0o644, Size: 3, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("abc"))
	_ = tw.Close()
	_ = f.Close()

	src, err := OpenTar(p, "tar", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenTar: %v", err)
	}
	defer src.Close()
	pages, _ := src.ListPages()
	if len(pages) != 1 || pages[0].Path != "001.png" || strings.HasPrefix(pages[0].Path, "./") {
		t.Fatalf("条目名未规整: %+v", pages)
	}
}
