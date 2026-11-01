package images

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"fakenews-comics/internal/sources"
)

// 缩略图：缩放不放大、输出 JPEG、可解码。
func TestMakeThumb(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "fakenews-comics", "格林童话")
	root := filepath.Join(dir, "第01卷")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Skipf("夹具不存在: %v", err)
	}
	var srcPath string
	for _, e := range entries {
		if sources.IsImageName(e.Name()) {
			srcPath = filepath.Join(root, e.Name())
			break
		}
	}
	if srcPath == "" {
		t.Skip("无图片夹具")
	}
	raw, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatal(err)
	}
	out, err := MakeThumb(raw, 320, 76)
	if err != nil {
		t.Fatalf("MakeThumb: %v", err)
	}
	if out.ContentType != "image/jpeg" {
		t.Fatalf("ContentType = %s", out.ContentType)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(out.Buffer))
	if err != nil {
		t.Fatalf("输出不可解码: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("格式 = %s, want jpeg", format)
	}
	if cfg.Width > 320 {
		t.Fatalf("宽度 %d 超过目标 320", cfg.Width)
	}
	t.Logf("%s → %d×%d JPEG (%d bytes)", filepath.Base(srcPath), cfg.Width, cfg.Height, len(out.Buffer))
}

// 缩放后的内容与源图同源（像素均值接近，允许重采样误差）。
func TestMakeThumbPreservesContent(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "fakenews-comics", "格林童话", "第01卷")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("夹具不存在: %v", err)
	}
	var srcPath string
	for _, e := range entries {
		if sources.IsImageName(e.Name()) {
			srcPath = filepath.Join(dir, e.Name())
			break
		}
	}
	raw, err := os.ReadFile(srcPath)
	if err != nil {
		t.Skip("读夹具失败")
	}
	out, err := MakeThumb(raw, 200, 80)
	if err != nil {
		t.Fatalf("MakeThumb: %v", err)
	}
	srcImg, _, err := DecodeImage(raw)
	if err != nil {
		t.Fatalf("源图解码: %v", err)
	}
	dstImg, _, err := DecodeImage(out.Buffer)
	if err != nil {
		t.Fatalf("缩略图解码: %v", err)
	}
	if meanBrightness(srcImg) == 0 {
		t.Skip("源图为纯黑，跳过亮度对比")
	}
	srcMean := meanBrightness(srcImg)
	dstMean := meanBrightness(dstImg)
	diff := srcMean - dstMean
	if diff < -20 || diff > 20 {
		t.Fatalf("亮度偏差过大: src=%.1f dst=%.1f", srcMean, dstMean)
	}
}

func meanBrightness(img image.Image) float64 {
	b := img.Bounds()
	var sum float64
	var n int
	// 采样（步长 16px）避免大图慢
	for y := b.Min.Y; y < b.Max.Y; y += 16 {
		for x := b.Min.X; x < b.Max.X; x += 16 {
			r, g, bl, _ := img.At(x, y).RGBA()
			sum += float64(r>>8+r>>8+g>>8+bl>>8) / 3
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

// EXIF Orientation 6（顺时针 90°）：解析 + 应用（宽高应交换）。
func TestExifOrientation(t *testing.T) {
	// 构造 2×3 源图（宽 2 高 3）
	src := image.NewRGBA(image.Rect(0, 0, 2, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 2; x++ {
			src.Set(x, y, color.RGBA{uint8(x * 100), uint8(y * 80), 128, 255})
		}
	}
	var jbuf bytes.Buffer
	if err := jpeg.Encode(&jbuf, src, nil); err != nil {
		t.Fatal(err)
	}
	withExif := insertExifAPP1(jbuf.Bytes(), 6)

	if got := parseExifOrientation(withExif); got != 6 {
		t.Fatalf("parseExifOrientation = %d, want 6", got)
	}
	if got := parseExifOrientation(jbuf.Bytes()); got != 1 {
		t.Fatalf("无 EXIF 时应为 1, got %d", got)
	}

	img, _, err := image.Decode(bytes.NewReader(withExif))
	if err != nil {
		t.Fatalf("解码带 EXIF 的 JPEG: %v", err)
	}
	out := applyExifOrientation(withExif, img)
	b := out.Bounds()
	if b.Dx() != 3 || b.Dy() != 2 {
		t.Fatalf("orientation 6 后尺寸 %dx%d, want 3x2（宽高交换）", b.Dx(), b.Dy())
	}
}

// insertExifAPP1 在 JPEG 的 SOI 之后插入构造的 EXIF APP1 段（Orientation）。
func insertExifAPP1(jpegBytes []byte, orientation int) []byte {
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08") // 大端，IFD0 偏移 8
	tiff = append(tiff, 0x00, 0x01)              // 1 个 entry
	entry := []byte{0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, byte(orientation), 0x00, 0x00}
	tiff = append(tiff, entry...)
	app1 := append([]byte("Exif\x00\x00"), tiff...)
	segLen := len(app1) + 2
	seg := []byte{0xFF, 0xE1, byte(segLen >> 8), byte(segLen)}
	seg = append(seg, app1...)
	out := make([]byte, 0, len(jpegBytes)+len(seg))
	out = append(out, jpegBytes[0], jpegBytes[1]) // SOI
	out = append(out, seg...)
	out = append(out, jpegBytes[2:]...)
	return out
}
