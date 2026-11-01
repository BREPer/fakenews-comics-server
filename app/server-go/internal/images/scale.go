// 缩放与编码：读图（含 EXIF 方向）→ x/image 缩放 → JPEG 编码。
// 缩放输出 JPEG（前端按 Content-Type 消费，无感知）。
//
// 缩放算法选 CatmullRom（三次卷积，锐度接近 Lanczos，
// x/image 无 Lanczos 实现；draw.ApproxBiLinear 更快但偏软）。
//
// 内存约束（2026-10-22 实测后补强）：
//   - 解码必须整张分配位图（4000×6000 → 96MB），所以 decode→scale→encode 全程走
//     lib 的全局并发闸（IMG_CONCURRENCY，默认 2），把并发峰值钉在 ~200MB 量级
//   - 解码前先用 DecodeConfig 读表头做像素上限检查，避免病态大图直接 OOM
//     （纯 Go 没有 shrink-on-load，这是唯一能提前止损的位置）
package images

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"sync/atomic"

	// 注册解码器
	_ "image/gif"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"fakenews-comics/internal/gate"
	"fakenews-comics/internal/lib"
)

// defaultMaxDecodeMP 单张图解码后的最大像素（百万）。60MP≈240MB RGBA：
// 双页跨页扫（4000×6000=24MP）、超长条漫（800×30000=24MP）都在范围内，
// 再大基本是坏文件或恶意图，直接 415 拒掉比 OOM 好。
const defaultMaxDecodeMP = 60

var maxDecodePixels atomic.Int64

func init() { maxDecodePixels.Store(defaultMaxDecodeMP * 1000 * 1000) }

// ConfigureDecodeLimit 设置单张图解码像素上限（<=0 回落默认）。
// 由 main 在启动时按 MAX_DECODE_MP 环境变量调用。
func ConfigureDecodeLimit(megapixels int) {
	if megapixels <= 0 {
		megapixels = defaultMaxDecodeMP
	}
	maxDecodePixels.Store(int64(megapixels) * 1000 * 1000)
}

// DecodeLimitPixels 当前像素上限（测试/自检用）。
func DecodeLimitPixels() int64 { return maxDecodePixels.Load() }

// DecodeImage 解码图片字节（jpeg/png/gif/webp）。
func DecodeImage(raw []byte) (image.Image, string, error) {
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", err
	}
	return img, format, nil
}

// EncodeJPEG 编码 JPEG。
func EncodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ThumbResult 缩略图结果。
type ThumbResult struct {
	Buffer      []byte
	ContentType string
}

// MakeThumb 读图 → EXIF 定向 → 缩放到目标宽 → JPEG。
// quality：JPEG 质量（标准画质 76 / 封面 85）。
//
// 注意：整段解码在并发闸内执行——调用方无需自己限流，但也要意识到
// 这是**阻塞**调用（闸满时排队）。
func MakeThumb(raw []byte, width, quality int) (*ThumbResult, error) {
	// 1) 表头检查（便宜，不入闸）：挡住病态大图
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, lib.BadSource("invalid image dimensions: %dx%d", cfg.Width, cfg.Height)
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if pixels > maxDecodePixels.Load() {
		return nil, lib.BadSource("image too large: %dx%d (%d MP, limit %d MP)",
			cfg.Width, cfg.Height, pixels/1000000, maxDecodePixels.Load()/1000000)
	}

	// 2) 解码 → 缩放 → 编码，全程持闸（大图按像素额外串行）
	release := gate.AcquireImageSlotFor(pixels)
	defer release()

	img, _, err := DecodeImage(raw)
	if err != nil {
		return nil, err
	}
	img = applyExifOrientation(raw, img)
	b := img.Bounds()
	if width > 0 && b.Dx() > width {
		h := b.Dy() * width / b.Dx()
		if h < 1 {
			h = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, width, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		img = dst
	}
	buf, err := EncodeJPEG(img, quality)
	if err != nil {
		return nil, err
	}
	return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
}

/* ---------------- EXIF 方向（最小实现） ---------------- */

// applyExifOrientation 按 EXIF Orientation 旋转/翻转图像。
// JPEG 的 APP1/Exif 段 → IFD0 → tag 0x0112。无 EXIF 或方向 1 时原样返回。
func applyExifOrientation(raw []byte, img image.Image) image.Image {
	orient := parseExifOrientation(raw)
	if orient <= 1 {
		return img
	}
	return orientImage(img, orient)
}

// parseExifOrientation 从 JPEG 字节解析 Orientation（1-8；失败返回 1）。
func parseExifOrientation(raw []byte) int {
	if len(raw) < 4 || raw[0] != 0xFF || raw[1] != 0xD8 {
		return 1 // 非 JPEG
	}
	i := 2
	for i+4 <= len(raw) {
		if raw[i] != 0xFF {
			return 1
		}
		marker := raw[i+1]
		if marker == 0xD9 || marker == 0xDA { // EOI / SOS：后面是扫描数据，停止
			return 1
		}
		size := int(binary.BigEndian.Uint16(raw[i+2 : i+4]))
		if size < 2 || i+2+size > len(raw) {
			return 1
		}
		seg := raw[i+4 : i+2+size]
		// APP1 + "Exif\0\0"
		if marker == 0xE1 && len(seg) >= 6 && string(seg[:6]) == "Exif\x00\x00" {
			return orientationFromTIFF(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func orientationFromTIFF(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch {
	case tiff[0] == 'I' && tiff[1] == 'I':
		bo = binary.LittleEndian
	case tiff[0] == 'M' && tiff[1] == 'M':
		bo = binary.BigEndian
	default:
		return 1
	}
	ifdOff := int(bo.Uint32(tiff[4:8]))
	if ifdOff+2 > len(tiff) {
		return 1
	}
	n := int(bo.Uint16(tiff[ifdOff : ifdOff+2]))
	if ifdOff+2+n*12 > len(tiff) {
		return 1
	}
	for k := 0; k < n; k++ {
		e := tiff[ifdOff+2+k*12 : ifdOff+2+(k+1)*12]
		if bo.Uint16(e[0:2]) == 0x0112 { // Orientation
			o := int(bo.Uint16(e[8:10]))
			if o < 1 || o > 8 {
				return 1
			}
			return o
		}
	}
	return 1
}

// orientImage 按 EXIF 方向变换（透明填充白色背景）。
func orientImage(src image.Image, orient int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if orient >= 5 {
		w, h = h, w // 5-8 交换宽高
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	// 先铺白（PNG 透明区旋转后避免黑边）
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			c := src.At(b.Min.X+x, b.Min.Y+y)
			var tx, ty int
			switch orient {
			case 2: // 水平翻转
				tx, ty = w-1-x, y
			case 3: // 180°
				tx, ty = w-1-x, h-1-y
			case 4: // 垂直翻转
				tx, ty = x, h-1-y
			case 5: //  transpose（左上→右上）
				tx, ty = y, x
			case 6: // 顺时针 90°
				tx, ty = h-1-y, x
			case 7: // transverse
				tx, ty = h-1-y, w-1-x
			case 8: // 逆时针 90°
				tx, ty = y, w-1-x
			default:
				tx, ty = x, y
			}
			dst.Set(tx, ty, c)
		}
	}
	return dst
}

// EncodePNG 编码 PNG（调试/测试用）。
func EncodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("png encode: %w", err)
	}
	return buf.Bytes(), nil
}

// DecodeImageFile 从文件读图（测试辅助）。
func DecodeImageFile(p string) (image.Image, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}
