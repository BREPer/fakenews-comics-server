// PDF 源：WASM PDFium（klippa-app/go-pdfium，wazero 运行时，无 CGO、可交叉编译）。
// PDF 渲染基于 WASM PDFium：
//   - 页数、元数据、加密 PDF（Password）、按目标宽度渲染、原图全分辨率渲染
//   - 单进程内嵌 WASM 二进制（internal/pdfium_wasm/pdfium.wasm 随模块 vendor）
//
// 内存与并发约束（关键，别改回「长期持有实例」）：
//   - WASM 实例池是有上限的（MaxTotal），**一个实例同一时刻只能服务一个文档**。
//     早期实现让每个 PdfSource 在生命周期内独占一个实例，而源缓存同时持有最多 24 个源，
//     于是第 2 本 PDF 打开就会阻塞 30s 报 "Timeout waiting for idle object"。
//     现在改为**按操作借还**：每次渲染/读元数据临时取实例→开文档→操作→关文档→还实例。
//   - 借用期短（毫秒级），池只需 2 个实例即可支撑多本 PDF 交替使用。
//   - 原图渲染结果按 index LRU（上限 pdfPageCacheMax），缩略图不进 LRU。
package sources

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"os"
	"sync"
	"time"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"

	"fakenews-comics/internal/gate"
)

const (
	// pdfRenderMaxDim 渲染宽度的绝对上限（纯安全阀，正常不会触到：
	// 按 PDF_RENDER_SCALE=2 算，Letter 612pt → 1224px，A3 842pt → 1684px）
	pdfRenderMaxDim = 8192
	// pdfMaxRenderPixels 单次光栅化的像素上限（约 40MP ≈ 160MB RGBA）。
	// 页面 pt 尺寸很大（如 2000×3000pt 的海报）时按比例缩宽度，避免一张图吃掉几百 MB。
	pdfMaxRenderPixels = 40 * 1000 * 1000
	// pdfPageCacheMax 单文档原图渲染 LRU 页数上限。
	// 6 页（预加载窗口 3 + 余量），原图翻页仍几乎全命中。
	pdfPageCacheMax = 6
	// pdfPageCacheBytesDefault 单文档原图页缓存的总字节上限（默认 64MB）。
	// 页数少但页面巨大时靠它兜底（否则 6 页 × 大页面 JPEG 也能到几百 MB）。
	pdfPageCacheBytesDefault = 64 * 1024 * 1024
	// pdfInstanceTimeout 获取 WASM 实例的超时。
	pdfInstanceTimeout = 30 * time.Second
	// pdfDefaultRenderScale 默认渲染倍率（RENDER_SCALE = 2）
	// （相对 PDF 点尺寸；1pt = 1/72 inch）。
	pdfDefaultRenderScale = 2.0
)

var (
	// pdfRenderScale 渲染倍率（PDF_RENDER_SCALE 可配）。
	pdfRenderScale = pdfDefaultRenderScale
	// pdfPageCacheBytes 页缓存字节上限（PDF_PAGE_CACHE_MB 可配）。
	pdfPageCacheBytes int64 = pdfPageCacheBytesDefault
	pdfCfgOnce        sync.Once
)

// ConfigurePDF 设置 PDF 渲染倍率与页缓存字节上限（<=0 回落默认）。幂等。
// 由 main 启动时按环境变量调用；测试不调用则用默认值。
func ConfigurePDF(scale float64, pageCacheMB int) {
	pdfCfgOnce.Do(func() {
		if scale > 0 {
			pdfRenderScale = scale
		}
		if pageCacheMB > 0 {
			pdfPageCacheBytes = int64(pageCacheMB) * 1024 * 1024
		}
	})
}

// PDFRenderScale 当前渲染倍率（自检/测试用）。
func PDFRenderScale() float64 { return pdfRenderScale }

// PDFPageCacheBytes 当前页缓存字节上限（自检/测试用）。
func PDFPageCacheBytes() int64 { return pdfPageCacheBytes }


// ErrPageOutOfRange 页索引越界。
var ErrPageOutOfRange = errors.New("page index out of range")

var (
	pdfiumPool pdfium.Pool
	pdfiumOnce sync.Once
	pdfiumErr  error
)

// getPdfium 全局单例实例池。
// MaxTotal=2：允许「一本在渲染 + 另一本在读元数据/页数」并行，
// 同时保住内存上限（每实例是独立 WASM 线性内存，不随文档数增长）。
func getPdfium() (pdfium.Pool, error) {
	pdfiumOnce.Do(func() {
		pdfiumPool, pdfiumErr = webassembly.Init(webassembly.Config{
			MinIdle:  1,
			MaxIdle:  2,
			MaxTotal: 2,
		})
	})
	return pdfiumPool, pdfiumErr
}

// PdfSource 单本 PDF（整本作为一章）。
// 不持有 WASM 实例与文档句柄——见文件头「内存与并发约束」。
type PdfSource struct {
	path     string
	numPages int

	// 文档内渲染串行：避免同一文档多页并发抢池，压住瞬时内存峰值
	renderMu sync.Mutex

	// 原图渲染 LRU（页数 + 总字节双上限）
	cacheMu    sync.Mutex
	cacheKeys  []int
	cacheData  map[int][]byte
	cacheBytes int64
}

// OpenPdf 打开 PDF 文档并读到页数，随后立即归还实例。
// 用 FileReader（io.ReadSeeker）而非 FilePath：WASM 后端按需回调读取，
// Go 侧零拷贝、不全量载入，且不依赖宿主机路径风格（Windows 卷标在 WASM 里不可见）。
func OpenPdf(path string) (*PdfSource, error) {
	p := &PdfSource{path: path, cacheData: map[int][]byte{}}
	err := p.withDoc(func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error {
		count, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc})
		if err != nil {
			return err
		}
		p.numPages = count.PageCount
		return nil
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// withDoc 借用实例 + 打开文档执行 fn，返回时必定关闭文档并归还实例。
// 任何一步失败都保证不泄漏（实例是有限资源，泄漏会让后续 PDF 全部超时）。
func (p *PdfSource) withDoc(fn func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error) error {
	pool, err := getPdfium()
	if err != nil {
		return err
	}
	f, err := os.Open(p.path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	inst, err := pool.GetInstance(pdfInstanceTimeout)
	if err != nil {
		return fmt.Errorf("cannot open pdf: %w", err)
	}
	defer func() { _ = inst.Close() }() // 归还 worker（必须无条件执行）

	doc, err := inst.OpenDocument(&requests.OpenDocument{
		FileReader:     f,
		FileReaderSize: st.Size(),
	})
	if err != nil {
		return err
	}
	defer func() { _, _ = inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) }()

	return fn(inst, doc.Document)
}

// Format 源格式（实现 ComicSource）。
func (p *PdfSource) Format() string { return "pdf" }

// NumPages 页数。
func (p *PdfSource) NumPages() int { return p.numPages }

// ReadMetadata 内嵌元数据（ComicSource 接口）。
func (p *PdfSource) ReadMetadata() (*SourceMetadata, error) {
	var md *SourceMetadata
	err := p.withDoc(func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error {
		get := func(tag string) string {
			if v, err := inst.FPDF_GetMetaText(&requests.FPDF_GetMetaText{Document: doc, Tag: tag}); err == nil {
				return v.Value
			}
			return ""
		}
		title, author, subject := get("Title"), get("Author"), get("Subject")
		if title == "" && author == "" && subject == "" {
			return nil
		}
		md = &SourceMetadata{Title: title, Author: author, Summary: subject}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return md, nil
}

// GetPageImage 渲染指定页为 JPEG。
// targetWidth > 0：按目标宽度（缩略图/封面，不进 LRU）；
// targetWidth <= 0：原图（按 PDF_RENDER_SCALE 倍率渲染，进 LRU）。
//
// 渲染宽度按**页面 pt 尺寸**换算（viewBox scale 语义）。
// 早期实现把 Width 直接写死 8192，等于把 Letter 页放大 13 倍渲染成 95MP/380MB，
// 这是 2026-10-22 实测 3.6GB 峰值的第二个来源）。
func (p *PdfSource) GetPageImage(index int, targetWidth int) ([]byte, error) {
	if index < 0 || index >= p.numPages {
		return nil, ErrPageOutOfRange
	}
	original := targetWidth <= 0
	if original {
		if buf, ok := p.cacheGet(index); ok {
			return buf, nil
		}
	}

	// 同一文档的渲染串行：并发抢池没意义，还会放大瞬时内存
	p.renderMu.Lock()
	defer p.renderMu.Unlock()

	// 二次检查：等锁期间别的请求可能已经渲染好了同一页
	if original {
		if buf, ok := p.cacheGet(index); ok {
			return buf, nil
		}
	}

	var buf []byte
	err := p.withDoc(func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error {
		width, pixels := renderWidthPixels(inst, doc, index, targetWidth)
		// 光栅化同样是「一次分配整张位图」，与缩略图解码共用同一个并发闸
		release := gate.AcquireImageSlotFor(pixels)
		defer release()
		out, err := inst.RenderToFile(&requests.RenderToFile{
			RenderPageInPixels: &requests.RenderPageInPixels{
				Page:  requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: index}},
				Width: width,
			},
			OutputFormat:  requests.RenderToFileOutputFormatJPG,
			OutputTarget:  requests.RenderToFileOutputTargetBytes,
			OutputQuality: 90,
		})
		if err != nil {
			return err
		}
		buf = *out.ImageBytes
		return nil
	})
	if err != nil {
		return nil, err
	}
	if original {
		p.cachePut(index, buf)
	}
	return buf, nil
}

// renderWidthOf 按页面 pt 尺寸与倍率算渲染宽度。
//   - 原图：pageWidthPt × pdfRenderScale（默认 2）
//   - 缩略图：min(pdfRenderScale, max(0.5, targetWidth/pageWidthPt)) × pageWidthPt
//     （小页面不放大、保清晰下限 0.5，与 TS 完全一致）
//   - 任何情况下不超过 pdfRenderMaxDim 与 pdfMaxRenderPixels
func renderWidthPixels(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, index, targetWidth int) (int, int64) {
	scale := pdfRenderScale
	pageW, pageH := 0.0, 0.0
	if size, err := inst.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc, Index: index}); err == nil && size.Width > 0 {
		pageW, pageH = size.Width, size.Height
	}

	if targetWidth > 0 {
		if pageW > 0 {
			s := float64(targetWidth) / pageW
			if s > pdfRenderScale {
				s = pdfRenderScale
			}
			if s < 0.5 {
				s = 0.5
			}
			scale = s
		} else {
			// 拿不到页面尺寸：只能把目标宽度当宽度用（高度未知，按 1.4 估像素）
			if targetWidth > pdfRenderMaxDim {
				targetWidth = pdfRenderMaxDim
			}
			return targetWidth, int64(targetWidth) * int64(float64(targetWidth)*1.4)
		}
	} else if pageW <= 0 {
		// 原图但拿不到尺寸：用保守宽度（Letter@2x 量级），避免退化成 8192
		return 1224, int64(1224 * 1731)
	}

	width := int(pageW*scale + 0.5)
	if width < 1 {
		width = 1
	}
	if pageH > 0 {
		// 像素上限：等比缩小宽度
		if px := float64(width) * (float64(width) * pageH / pageW); px > float64(pdfMaxRenderPixels) {
			k := math.Sqrt(float64(pdfMaxRenderPixels) / px)
			width = int(float64(width) * k)
			if width < 1 {
				width = 1
			}
		}
	}
	if width > pdfRenderMaxDim {
		width = pdfRenderMaxDim
	}
	estH := float64(width) * pageH / pageW
	if pageH <= 0 {
		estH = float64(width) * 1.4
	}
	return width, int64(float64(width) * estH)
}

// cacheGet 读原图页缓存（命中即刷新 LRU 顺序）。
func (p *PdfSource) cacheGet(index int) ([]byte, bool) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	buf, ok := p.cacheData[index]
	if !ok {
		return nil, false
	}
	for i, k := range p.cacheKeys {
		if k == index {
			p.cacheKeys = append(append(p.cacheKeys[:i], p.cacheKeys[i+1:]...), index)
			break
		}
	}
	return buf, true
}

// cachePut 写原图页缓存：页数上限 6 + 总字节上限（默认 64MB）双约束。
func (p *PdfSource) cachePut(index int, buf []byte) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	if p.cacheData == nil {
		p.cacheData = map[int][]byte{}
	}
	if old, ok := p.cacheData[index]; ok {
		p.cacheBytes -= int64(len(old))
	}
	p.cacheData[index] = buf
	p.cacheBytes += int64(len(buf))
	p.cacheKeys = append(p.cacheKeys, index)
	for len(p.cacheKeys) > pdfPageCacheMax || (p.cacheBytes > pdfPageCacheBytes && len(p.cacheKeys) > 1) {
		evict := p.cacheKeys[0]
		p.cacheKeys = p.cacheKeys[1:]
		if b, ok := p.cacheData[evict]; ok {
			p.cacheBytes -= int64(len(b))
			delete(p.cacheData, evict)
		}
	}
}

// ListPages 页清单（PDF 整本一章，页名 page-N；size 由渲染后才知道，填 0）。
func (p *PdfSource) ListPages() ([]PageEntry, error) {
	out := make([]PageEntry, p.numPages)
	for i := range out {
		name := fmt.Sprintf("page-%d", i+1)
		out[i] = PageEntry{Index: i, Name: name, Path: name, Size: 0}
	}
	return out, nil
}

// ListChapters PDF 整本作为单章（不分章），恒空。
func (p *PdfSource) ListChapters() ([]SourceChapter, error) { return nil, nil }

// GetPageStream 渲染指定页为 JPEG 后按 Range 切片。
// targetWidth > 0：缩略图/封面；<=0：原图全分辨率。
func (p *PdfSource) GetPageStream(index int, opts PageStreamOptions) (*PageStream, error) {
	buf, err := p.GetPageImage(index, opts.TargetWidth)
	if err != nil {
		return nil, err
	}
	total := int64(len(buf))
	start := opts.Start
	if start < 0 {
		start = 0
	}
	if start > total {
		start = total
	}
	length := opts.Length
	if length <= 0 || start+length > total {
		length = total - start
	}
	return &PageStream{
		Stream: bytes.NewReader(buf[start : start+length]),
		Size:   length,
		Mime:   "image/jpeg",
	}, nil
}

// Close 释放文档级缓存（实例/句柄早已按操作归还，无需在此处理）。
func (p *PdfSource) Close() {
	p.cacheMu.Lock()
	p.cacheData = map[int][]byte{}
	p.cacheKeys = nil
	p.cacheMu.Unlock()
}
