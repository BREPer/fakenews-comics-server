// 内存治理不变式测试：解码像素上限、内存层 LRU 的字节淘汰与淘汰顺序。
package images

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"testing"

	"fakenews-comics/internal/lib"
)

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png encode: %v", err)
	}
	return buf.Bytes()
}

// TestDecodePixelLimit 超过像素上限的图必须 415 拒绝，而不是硬解码撑爆内存。
func TestDecodePixelLimit(t *testing.T) {
	old := DecodeLimitPixels()
	defer ConfigureDecodeLimit(int(old / 1000000))
	ConfigureDecodeLimit(1) // 1MP

	raw := makePNG(t, 1600, 1600) // 2.56MP > 1MP
	_, err := MakeThumb(raw, 320, 76)
	if err == nil {
		t.Fatal("超限图应报错")
	}
	var apiErr *lib.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("应为 APIError（映射 415），got %T: %v", err, err)
	}
	if apiErr.Status != 415 {
		t.Errorf("状态码 = %d, want 415", apiErr.Status)
	}

	// 上限内的图正常出图
	small := makePNG(t, 400, 500)
	out, err := MakeThumb(small, 200, 76)
	if err != nil {
		t.Fatalf("上限内应成功: %v", err)
	}
	if len(out.Buffer) == 0 || out.ContentType != "image/jpeg" {
		t.Fatalf("输出异常: len=%d type=%s", len(out.Buffer), out.ContentType)
	}
}

// TestMemCacheByteEviction 内存层按字节淘汰，且不会误删刚写入项。
func TestMemCacheByteEviction(t *testing.T) {
	defer func() {
		ConfigureMemCacheBytes(32)
		MemClear()
	}()
	MemClear()
	ConfigureMemCacheBytes(1) // 1MB

	big := make([]byte, 300*1024) // 每条约 300KB
	for i := 0; i < 10; i++ {
		MemSet(string(rune('a'+i)), big)
	}
	if got := MemBytes(); got > 1<<20 {
		t.Errorf("内存层占用 %d 超上限 %d", got, 1<<20)
	}
	if MemSize() > 3 {
		t.Errorf("条数 %d 偏多（1MB / 300KB 应约 3 条）", MemSize())
	}
	// 最后写入的必须还在（旧实现是 map 随机删，可能删掉刚写的）
	if _, ok := MemGet("j"); !ok {
		t.Error("最后写入的条目被误删")
	}
}

// TestMemCacheLRUOrder 访问应刷新顺序，淘汰从最久未用开始。
func TestMemCacheLRUOrder(t *testing.T) {
	defer func() {
		ConfigureMemCacheBytes(32)
		MemClear()
	}()
	MemClear()
	ConfigureMemCacheBytes(1)

	MemSet("keep", make([]byte, 400*1024))
	MemSet("drop1", make([]byte, 300*1024))
	// 触碰 keep → 变成最近使用
	if _, ok := MemGet("keep"); !ok {
		t.Fatal("keep 应存在")
	}
	// 持续写入直到超限触发淘汰（1MB 上限：400+300+300+300 必然超）
	MemSet("new1", make([]byte, 300*1024))
	MemSet("new2", make([]byte, 300*1024))
	if _, ok := MemGet("keep"); !ok {
		t.Error("最近访问过的 keep 不应被淘汰")
	}
	if _, ok := MemGet("drop1"); ok {
		t.Error("最久未用的 drop1 应被淘汰")
	}
}
