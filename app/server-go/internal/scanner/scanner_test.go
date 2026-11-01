package scanner

import (
	"os"
	"path/filepath"
	"testing"
)

// fx 返回自建夹具库里的子路径（见 fixture_test.go）。
// 不再读 %TEMP%/fakenews-comics：那是手工调试与 E2E 共用的目录，内容会漂。
func fx(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(fixture(t), name)
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("夹具缺项 %q: %v", name, err)
	}
	return p
}

// 章节型 folder：子目录各一章，ID 为 <comicId>#<index>，format=folder。
func TestBuildChaptersFolder(t *testing.T) {
	p := fx(t, "格林童话")
	chapters, err := buildChapters(p, "folder", "cid123", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 2 {
		t.Fatalf("章数 = %d, want 2", len(chapters))
	}
	if chapters[0].ID != "cid123#0" || chapters[1].ID != "cid123#1" {
		t.Fatalf("章 id = %q/%q", chapters[0].ID, chapters[1].ID)
	}
	if chapters[0].Title != "第01卷" || chapters[1].Title != "第02卷" {
		t.Fatalf("章标题 = %q/%q", chapters[0].Title, chapters[1].Title)
	}
	if chapters[0].Format != "folder" || chapters[0].Path != filepath.Join(p, "第01卷") {
		t.Fatalf("章定位错: %+v", chapters[0])
	}
}

// 混合结构：顶层散图章（topOnly）→ 子目录章。
func TestBuildChaptersMixed(t *testing.T) {
	p := fx(t, "混合结构")
	chapters, err := buildChapters(p, "folder", "cidMix", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 3 {
		t.Fatalf("章数 = %d, want 3（散图 + 2 子目录）", len(chapters))
	}
	if !chapters[0].TopOnly || chapters[0].Path != p {
		t.Fatalf("首章应为顶层散图章: %+v", chapters[0])
	}
	if chapters[0].PageCount != 1 {
		t.Fatalf("散图章页数 = %d, want 1", chapters[0].PageCount)
	}
	if chapters[1].Title != "第01卷" || chapters[2].Title != "第02卷" {
		t.Fatalf("后续章标题错: %q %q", chapters[1].Title, chapters[2].Title)
	}
}

// 三章 folder。
func TestBuildChaptersThreeDirs(t *testing.T) {
	p := fx(t, "阿飞正传")
	chapters, err := buildChapters(p, "folder", "cidA", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 3 {
		t.Fatalf("章数 = %d, want 3", len(chapters))
	}
}

// zip 包内一级目录 = 章。
func TestBuildChaptersZip(t *testing.T) {
	p := fx(t, "刮削测试.cbz")
	chapters, err := buildChapters(p, "cbz", "cidZ", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) < 2 {
		t.Fatalf("包内章数 = %d, want ≥2", len(chapters))
	}
	for _, c := range chapters {
		if c.Prefix == "" || c.Path != p {
			t.Fatalf("zip 章定位错: %+v", c)
		}
		if c.PageCount == 0 {
			t.Fatalf("章 %q 页数为 0", c.Title)
		}
	}
	t.Logf("刮削测试.cbz %d 章：", len(chapters))
	for _, c := range chapters {
		t.Logf("  #%d %s (%d 页)", c.Index, c.Title, c.PageCount)
	}
}

// epub 整本一章（spine 页序）。
func TestBuildChaptersEpub(t *testing.T) {
	p := fx(t, "EPUB测试.epub")
	chapters, err := buildChapters(p, "epub", "cidE", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 1 {
		t.Fatalf("epub 章数 = %d, want 1", len(chapters))
	}
	// 章级 PageCount 懒加载为 0 是 TS 既定行为（进入章时按需算），全书页数以扫描入库的 page_count 为准
	if chapters[0].Path != p {
		t.Fatalf("epub 章定位 = %q, want %q", chapters[0].Path, p)
	}
}

// 单篇型：整册一章，页数 = 全部图。
func TestBuildChaptersSingle(t *testing.T) {
	p := fx(t, "格林童话")
	chapters, err := buildChapters(p, "folder", "cidS", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 1 {
		t.Fatalf("单篇型章数 = %d, want 1", len(chapters))
	}
	if chapters[0].PageCount == 0 {
		t.Fatal("单篇型页数为 0")
	}
	if chapters[0].ID != "cidS#0" {
		t.Fatalf("章 id = %q", chapters[0].ID)
	}
}

// ListChapters 缓存：短时间内两次调用一致；返回副本（改返回值不污染缓存）。
func TestListChaptersCache(t *testing.T) {
	p := fx(t, "格林童话")
	a, err := ListChapters(p, "folder", "cidCache", true)
	if err != nil {
		t.Fatal(err)
	}
	a[0].Title = "被污染的标题"
	b, err := ListChapters(p, "folder", "cidCache", true)
	if err != nil {
		t.Fatal(err)
	}
	if b[0].Title == "被污染的标题" {
		t.Fatal("缓存被调用方污染")
	}
	if len(a) != len(b) {
		t.Fatal("两次调用章数不一致")
	}
}

// IDFromPath 稳定、路径敏感。
func TestIDFromPath(t *testing.T) {
	if IDFromPath("/a/b") != IDFromPath("/a/b") {
		t.Fatal("同路径应得同 id")
	}
	if IDFromPath("/a/b") == IDFromPath("/a/c") {
		t.Fatal("不同路径应得不同 id")
	}
}

// WalkRoot：根不 promote；含图子目录提升；松散压缩包独立成候选；隐藏目录跳过。
func TestWalkRoot(t *testing.T) {
	root := fx(t, "")
	var files, folders int
	var paths []string
	WalkRoot(root, func(c Candidate) {
		if c.Kind == "file" {
			files++
		} else {
			folders++
		}
		paths = append(paths, c.Path)
	}, true)

	// 根级松散压缩包 3 个 + folder 候选 5 个（格林童话/刮削目录/样张测试/混合结构/阿飞正传）
	if files != 3 {
		t.Fatalf("文件候选 = %d, want 3", files)
	}
	if folders != 5 {
		t.Fatalf("folder 候选 = %d, want 5", folders)
	}
	for _, p := range paths {
		if filepath.Base(filepath.Dir(p)) == ".hidden" || filepath.Base(p) == ".hidden" {
			t.Fatal("隐藏目录未被跳过")
		}
	}
	// 样张测试：含图子目录 → 提升为 folder（不继续下钻发出第01卷）
	for _, p := range paths {
		if filepath.Base(p) == "第01卷" {
			t.Fatalf("第01卷 不应作为独立候选（应被提升）：%s", p)
		}
	}
}

// WalkRoot promote=false（单篇型）：每个含图文件夹各自成书，不下钻提升。
func TestWalkRootSingleType(t *testing.T) {
	root := fx(t, "")
	var folders, files int
	WalkRoot(root, func(c Candidate) {
		if c.Kind == "file" {
			files++
		} else {
			folders++
		}
	}, false)
	// 单篇型：根级含图文件夹直接成书；子目录继续下钻
	t.Logf("单篇型候选：folder=%d file=%d", folders, files)
	if files != 3 {
		t.Fatalf("根级文件候选 = %d, want 3", files)
	}
	if folders == 0 {
		t.Fatal("单篇型应有 folder 候选")
	}
}
