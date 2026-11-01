// 内存相关不变式测试：
//   - 原图渲染宽度按 pt × 倍率算（不能退化成写死的 8192）
//   - 缩略图宽度受倍率上限与 0.5 下限约束
//   - 原图页缓存受「页数 + 字节」双上限约束
package sources

import (
	"testing"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
)

// TestPdfRenderWidthSemantics 渲染宽度必须由页面 pt 尺寸推导。
// 历史 bug：Width 直接传 8192，Letter 页被渲染成 8192×11586（95MP，约 380MB 位图）。
func TestPdfRenderWidthSemantics(t *testing.T) {
	src, err := OpenPdf(pdfTestdata)
	if err != nil {
		t.Fatalf("OpenPdf: %v", err)
	}
	defer src.Close()

	var pageW, pageH float64
	var origW, thumbW, smallTargetW int
	var origPx int64
	err = src.withDoc(func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error {
		size, err := inst.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc, Index: 0})
		if err != nil {
			return err
		}
		pageW, pageH = size.Width, size.Height
		origW, origPx = renderWidthPixels(inst, doc, 0, 0)       // 原图
		thumbW, _ = renderWidthPixels(inst, doc, 0, 320)         // 缩略图（320 宽）
		smallTargetW, _ = renderWidthPixels(inst, doc, 0, 60)    // 极小目标 → 触发 0.5 下限
		return nil
	})
	if err != nil {
		t.Fatalf("withDoc: %v", err)
	}
	t.Logf("页面 %.1f×%.1f pt → 原图宽 %d（估 %.1fMP）/ 缩略图宽 %d / 极小目标宽 %d",
		pageW, pageH, origW, float64(origPx)/1e6, thumbW, smallTargetW)

	// 原图 = pt × PDF_RENDER_SCALE(2)
	wantOrig := int(pageW*pdfRenderScale + 0.5)
	if origW != wantOrig {
		t.Errorf("原图宽 = %d, want %d（pt×%.1f）", origW, wantOrig, pdfRenderScale)
	}
	if origW >= pdfRenderMaxDim {
		t.Errorf("原图宽 %d 触到安全阀 %d，说明倍率语义又丢了", origW, pdfRenderMaxDim)
	}
	// 缩略图：目标 320 且 320/pageW > 0.5 → 正好 320
	if thumbW != 320 {
		t.Errorf("缩略图宽 = %d, want 320", thumbW)
	}
	// 极小目标：0.5 下限生效 → pageW × 0.5
	wantFloor := int(pageW*0.5 + 0.5)
	if smallTargetW != wantFloor {
		t.Errorf("0.5 下限宽 = %d, want %d", smallTargetW, wantFloor)
	}
}

// TestPdfPageCacheByteBudget 页缓存同时受 6 页与总字节约束。
func TestPdfPageCacheByteBudget(t *testing.T) {
	oldBytes := pdfPageCacheBytes
	defer func() { pdfPageCacheBytes = oldBytes }()
	pdfPageCacheBytes = 1 << 20 // 1MB，便于用小缓冲测出淘汰

	p := &PdfSource{numPages: 100, cacheData: map[int][]byte{}}
	page := make([]byte, 300*1024) // 300KB/页
	for i := 0; i < 10; i++ {
		p.cachePut(i, page)
	}
	if p.cacheBytes > pdfPageCacheBytes {
		t.Errorf("缓存占用 %d 超上限 %d", p.cacheBytes, pdfPageCacheBytes)
	}
	if len(p.cacheKeys) > pdfPageCacheMax {
		t.Errorf("缓存页数 %d 超上限 %d", len(p.cacheKeys), pdfPageCacheMax)
	}
	// 至少保留最新一页
	if _, ok := p.cacheGet(9); !ok {
		t.Error("最新页 9 应仍在缓存中")
	}
	// 最旧页应已被淘汰
	if _, ok := p.cacheData[0]; ok {
		t.Error("最旧页 0 应已被淘汰")
	}
	// 重复写入同一页不应重复计字节
	before := p.cacheBytes
	p.cachePut(9, page)
	if p.cacheBytes != before {
		t.Errorf("重复写入同页字节数 = %d, want %d", p.cacheBytes, before)
	}
}
