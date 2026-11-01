package sources

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// folder 源：递归页清单 + topOnly + Range。
func TestFolderSourceListPages(t *testing.T) {
	dir := fixtureDir(t)
	root := filepath.Join(dir, "格林童话")
	if _, err := os.Stat(root); err != nil {
		t.Skipf("夹具目录不存在: %v", err)
	}
	f, err := OpenFolder(root, OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenFolder: %v", err)
	}
	defer f.Close()
	pages, err := f.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	if len(pages) == 0 {
		t.Fatal("页清单为空")
	}
	t.Logf("格林童话 递归 %d 页", len(pages))
	// 递归应包含子目录图片
	hasSubdirPage := false
	for _, p := range pages {
		if filepath.Dir(p.Path) != root {
			hasSubdirPage = true
		}
	}
	if !hasSubdirPage {
		t.Error("递归列举未包含子目录图片")
	}
}

func TestFolderSourceTopOnly(t *testing.T) {
	dir := fixtureDir(t)
	root := filepath.Join(dir, "格林童话")
	if _, err := os.Stat(root); err != nil {
		t.Skipf("夹具目录不存在: %v", err)
	}
	f, err := OpenFolder(root, OpenSourceOptions{TopOnly: true})
	if err != nil {
		t.Fatalf("OpenFolder: %v", err)
	}
	defer f.Close()
	pages, err := f.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	for _, p := range pages {
		if filepath.Dir(p.Path) != root {
			t.Fatalf("topOnly 混入了子目录页: %s", p.Path)
		}
	}
	t.Logf("格林童话 topOnly %d 页", len(pages))
}

func TestFolderSourceRange(t *testing.T) {
	dir := fixtureDir(t)
	root := filepath.Join(dir, "格林童话")
	if _, err := os.Stat(root); err != nil {
		t.Skipf("夹具目录不存在: %v", err)
	}
	f, err := OpenFolder(root, OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenFolder: %v", err)
	}
	defer f.Close()
	whole, err := f.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal})
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
	part, err := f.GetPageStream(0, PageStreamOptions{Quality: QualityOriginal, Start: 10, Length: 100})
	if err != nil {
		t.Fatalf("Range: %v", err)
	}
	got, _ := io.ReadAll(part.Stream)
	if !bytes.Equal(got, all[10:110]) {
		t.Fatal("Range 切片与整读不一致")
	}
}

func TestFolderSourceMissing(t *testing.T) {
	if _, err := OpenFolder(filepath.Join(os.TempDir(), "fc-no-such-dir"), OpenSourceOptions{}); err == nil {
		t.Fatal("不存在的目录应报错")
	}
}
