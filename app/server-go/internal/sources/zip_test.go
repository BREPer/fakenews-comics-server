package sources

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// fixtureDir 测试夹具库（make_test_data.py 生成，%TEMP%/fakenews-comics）。
func fixtureDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(os.TempDir(), "fakenews-comics")
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Skipf("夹具不存在，先跑 python tools/make_test_data.py：%v", err)
	}
	return dir
}

func TestZipSourceListPages(t *testing.T) {
	dir := fixtureDir(t)
	// 刮削测试.cbz：包内一级目录各一章
	z, err := OpenZip(filepath.Join(dir, "刮削测试.cbz"), "cbz", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip: %v", err)
	}
	defer z.Close()

	pages, err := z.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	if len(pages) == 0 {
		t.Fatal("页清单为空")
	}
	t.Logf("刮削测试.cbz 共 %d 页，首页 %s (%d bytes)", len(pages), pages[0].Name, pages[0].Size)
	// 自然排序验证：按完整条目键（排序键就是完整名，basename 跨目录会误报）
	for i := 1; i < len(pages); i++ {
		if NaturalCompare(pages[i-1].Path, pages[i].Path) > 0 {
			t.Fatalf("页序错误: %s 在 %s 之前", pages[i-1].Path, pages[i].Path)
		}
	}
}

func TestZipSourceChapters(t *testing.T) {
	dir := fixtureDir(t)
	z, err := OpenZip(filepath.Join(dir, "刮削测试.cbz"), "cbz", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip: %v", err)
	}
	defer z.Close()
	chapters, err := z.ListChapters()
	if err != nil {
		t.Fatalf("ListChapters: %v", err)
	}
	t.Logf("包内 %d 章", len(chapters))
	if len(chapters) == 0 {
		t.Skip("该夹具无包内分章")
	}
	// prefix 视图：只列该章目录下的页
	zv, err := OpenZip(filepath.Join(dir, "刮削测试.cbz"), "cbz", OpenSourceOptions{Prefix: chapters[0].ID})
	if err != nil {
		t.Fatalf("OpenZip(prefix): %v", err)
	}
	defer zv.Close()
	pages, err := zv.ListPages()
	if err != nil {
		t.Fatalf("prefix ListPages: %v", err)
	}
	if len(pages) != chapters[0].PageCount {
		t.Fatalf("prefix 视图页数 %d != 章页数 %d", len(pages), chapters[0].PageCount)
	}
}

// 条目流 + Range：整读与切片读出的字节一致。
func TestZipSourcePageStream(t *testing.T) {
	dir := fixtureDir(t)
	z, err := OpenZip(filepath.Join(dir, "刮削测试.cbz"), "cbz", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip: %v", err)
	}
	defer z.Close()

	whole, err := z.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	all, err := io.ReadAll(whole.Stream)
	if err != nil {
		t.Fatalf("读流: %v", err)
	}
	if int64(len(all)) != whole.Size {
		t.Fatalf("size=%d 实际 %d", whole.Size, len(all))
	}
	if !bytes.HasPrefix(all, []byte("\x89PNG")) && !bytes.HasPrefix(all, []byte("\xff\xd8")) {
		t.Fatal("条目内容不是 PNG/JPEG")
	}

	// Range：取前 100 字节
	part, err := z.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal, Start: 0, Length: 100})
	if err != nil {
		t.Fatalf("Range GetPageStream: %v", err)
	}
	got, err := io.ReadAll(part.Stream)
	if err != nil {
		t.Fatalf("读 Range 流: %v", err)
	}
	if !bytes.Equal(got, all[:100]) {
		t.Fatal("Range 前 100 字节与整读不一致")
	}

	// Range：中段
	mid, err := z.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal, Start: 50, Length: 100})
	if err != nil {
		t.Fatalf("中段 Range: %v", err)
	}
	got2, _ := io.ReadAll(mid.Stream)
	if !bytes.Equal(got2, all[50:150]) {
		t.Fatal("中段 Range 字节与整读不一致")
	}
}

func TestZipSourceMetadata(t *testing.T) {
	dir := fixtureDir(t)
	z, err := OpenZip(filepath.Join(dir, "刮削测试.cbz"), "cbz", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip: %v", err)
	}
	defer z.Close()
	meta, err := z.ReadMetadata()
	if err != nil {
		t.Fatalf("ReadMetadata: %v", err)
	}
	if meta != nil {
		t.Logf("ComicInfo: title=%q author=%q genre=%v", meta.Title, meta.Author, meta.Genre)
	} else {
		t.Log("无 ComicInfo.xml（符合预期也无妨）")
	}
}

// EPUB：spine 决定页序。
func TestEpubSource(t *testing.T) {
	dir := fixtureDir(t)
	z, err := OpenZip(filepath.Join(dir, "EPUB测试.epub"), "epub", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenZip(epub): %v", err)
	}
	defer z.Close()
	pages, err := z.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	if len(pages) == 0 {
		t.Fatal("epub 页清单为空")
	}
	t.Logf("EPUB %d 页，首页 %s", len(pages), pages[0].Name)
	meta, _ := z.ReadMetadata()
	if meta != nil {
		t.Logf("OPF 元数据: title=%q author=%q", meta.Title, meta.Author)
	}
	// 逐页可读
	ps, err := z.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	b, err := io.ReadAll(io.LimitReader(ps.Stream, 16))
	if err != nil {
		t.Fatalf("读页: %v", err)
	}
	if len(b) == 0 {
		t.Fatal("首页内容为空")
	}
}

// 坏包：明确错误（415 语义由上层转换）。
func TestZipSourceBadArchive(t *testing.T) {
	dir := fixtureDir(t)
	bad := filepath.Join(dir, "not-a-zip.cbz")
	if err := os.WriteFile(bad, []byte("this is not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bad)
	if _, err := OpenZip(bad, "cbz", OpenSourceOptions{}); err == nil {
		t.Fatal("坏包应报错")
	}
}

// 不存在的文件：404 语义。
func TestZipSourceMissing(t *testing.T) {
	dir := fixtureDir(t)
	_, err := OpenZip(filepath.Join(dir, "no-such.cbz"), "cbz", OpenSourceOptions{})
	if err == nil {
		t.Fatal("不存在的包应报错")
	}
	var nf *notFoundError
	if !asNotFound(err, &nf) {
		t.Fatalf("错误类型 = %T, want notFoundError", err)
	}
}

func asNotFound(err error, target **notFoundError) bool {
	nf, ok := err.(*notFoundError)
	if ok {
		*target = nf
	}
	return ok
}
