// 测试夹具：整个漫画库由测试代码在临时目录里现造，不读 %TEMP%/fakenews-comics。
//
// 为什么不去读开发用的夹具目录：那个目录是手工调试与 E2E 探针共用的，谁往里加点东西
// （造性能数据、试刮削）都会让这里的断言从「8 部」变成「9 部」，测试就红了而产品代码没问题；
// 目录不存在时还得 t.Skipf，等于长期假绿。
//
// 这里：TestMain 里造一份到 os.MkdirTemp，包内所有测试共享（测试串行，互不干扰），
// 跑完删掉。文件内容用标准库生成（image/png + archive/zip），不引入二进制资源。
package scanner

import (
	"archive/zip"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

var (
	fixtureOnce sync.Once
	fixtureDir  string
	fixtureErr  error
)

// fixture 返回夹具库根（首次调用时生成）。
func fixture(t *testing.T) string {
	t.Helper()
	fixtureOnce.Do(func() {
		fixtureDir, fixtureErr = os.MkdirTemp("", "fakenews-fixture-")
		if fixtureErr != nil {
			return
		}
		fixtureErr = buildFixture(fixtureDir)
	})
	if fixtureErr != nil {
		t.Fatalf("生成夹具失败: %v", fixtureErr)
	}
	return fixtureDir
}

func TestMain(m *testing.M) {
	code := m.Run()
	if fixtureDir != "" {
		_ = os.RemoveAll(fixtureDir)
	}
	os.Exit(code)
}

func writePNGFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	// 尺寸给足，避免被当成占位图过滤
	return png.Encode(f, image.NewRGBA(image.Rect(0, 0, 40, 60)))
}

// writeImages 在 dir 下写 n 张 001.png…。
func writeImages(dir string, n int) error {
	for i := 1; i <= n; i++ {
		if err := writePNGFile(filepath.Join(dir, fmt.Sprintf("%03d.png", i))); err != nil {
			return err
		}
	}
	return nil
}

// writeZip 写一个 zip（entries: 条目名 → 字节）。
func writeZip(path string, entries map[string][]byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	zw := zip.NewWriter(f)
	// 固定顺序无所谓，但 map 遍历随机——测试只关心内容
	for name, data := range entries {
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

// pngBytes 生成一张 PNG 的字节（塞进压缩包用）。
func pngBytes() []byte {
	dir, err := os.MkdirTemp("", "fakenews-png-")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "x.png")
	if err := writePNGFile(p); err != nil {
		return nil
	}
	b, _ := os.ReadFile(p)
	return b
}

// buildFixture 造出与「8 部漫画」一致的库结构：
//
//	root/
//	  格林童话/第01卷(3)、第02卷(2)          → folder 候选，2 章
//	  混合结构/封面页.png + 第01卷(2)、第02卷(1) → folder 候选，3 章（散图章 + 2 子目录）
//	  阿飞正传/第01~03卷(各 2)                → folder 候选，3 章
//	  样张测试/sample.png + 第01卷(2)         → folder 候选（提升，不下钻）
//	  刮削目录/ComicInfo.xml + 第01卷(2)      → folder 候选 + 元数据
//	  .hidden/第01卷(2)                      → 隐藏，跳过
//	  刮削测试.cbz（包内 2 个一级目录）        → file 候选，≥2 章
//	  EPUB测试.epub（OPF spine）             → file 候选，1 章
//	  海贼王.cbz（3 页单篇）                  → file 候选
//
// 合计 5 folder + 3 file = 8 部。
func buildFixture(root string) error {
	// 格林童话
	if err := writeImages(filepath.Join(root, "格林童话", "第01卷"), 3); err != nil {
		return err
	}
	if err := writeImages(filepath.Join(root, "格林童话", "第02卷"), 2); err != nil {
		return err
	}
	// 混合结构：顶层一张散图（章 0 为 topOnly 散图章）
	if err := writePNGFile(filepath.Join(root, "混合结构", "封面页.png")); err != nil {
		return err
	}
	if err := writeImages(filepath.Join(root, "混合结构", "第01卷"), 2); err != nil {
		return err
	}
	if err := writeImages(filepath.Join(root, "混合结构", "第02卷"), 1); err != nil {
		return err
	}
	// 阿飞正传：三卷
	for _, v := range []string{"第01卷", "第02卷", "第03卷"} {
		if err := writeImages(filepath.Join(root, "阿飞正传", v), 2); err != nil {
			return err
		}
	}
	// 样张测试：顶层只有样张图，真正内容在子目录 → 子目录被提升
	if err := writePNGFile(filepath.Join(root, "样张测试", "sample.png")); err != nil {
		return err
	}
	if err := writeImages(filepath.Join(root, "样张测试", "第01卷"), 2); err != nil {
		return err
	}
	// 刮削目录：ComicInfo.xml 提供元数据
	if err := os.MkdirAll(filepath.Join(root, "刮削目录", "第01卷"), 0o755); err != nil {
		return err
	}
	comicInfo := `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Series>目录刮削</Series>
  <Title>单行本</Title>
  <Writer>目录作者</Writer>
  <Summary>目录版简介</Summary>
  <Genre>悬疑</Genre>
</ComicInfo>
`
	if err := os.WriteFile(filepath.Join(root, "刮削目录", "ComicInfo.xml"), []byte(comicInfo), 0o644); err != nil {
		return err
	}
	if err := writeImages(filepath.Join(root, "刮削目录", "第01卷"), 2); err != nil {
		return err
	}
	// 隐藏目录
	if err := writeImages(filepath.Join(root, ".hidden", "第01卷"), 2); err != nil {
		return err
	}

	img := pngBytes()
	// 刮削测试.cbz：包内一级目录 = 章
	if err := writeZip(filepath.Join(root, "刮削测试.cbz"), map[string][]byte{
		"第01卷/001.png": img,
		"第01卷/002.png": img,
		"第02卷/001.png": img,
	}); err != nil {
		return err
	}
	// 海贼王.cbz：单篇（整包一章）
	if err := writeZip(filepath.Join(root, "海贼王.cbz"), map[string][]byte{
		"001.png": img, "002.png": img, "003.png": img,
	}); err != nil {
		return err
	}
	// EPUB测试.epub：container.xml → OPF → spine（页序由 spine 决定）
	container := `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
	opf := `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EPUB 测试漫画</dc:title>
    <dc:creator>EPUB 作者</dc:creator>
  </metadata>
  <manifest>
    <item id="p1" href="images/001.png" media-type="image/png"/>
    <item id="p2" href="images/002.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="p1"/>
    <itemref idref="p2"/>
  </spine>
</package>
`
	return writeZip(filepath.Join(root, "EPUB测试.epub"), map[string][]byte{
		"mimetype":              []byte("application/epub+zip"),
		"META-INF/container.xml": []byte(container),
		"OEBPS/content.opf":     []byte(opf),
		"OEBPS/images/001.png":  img,
		"OEBPS/images/002.png":  img,
	})
}
