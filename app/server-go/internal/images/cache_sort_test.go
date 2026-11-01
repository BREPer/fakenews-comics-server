// 缓存淘汰的排序正确性与规模基准。
package images

import (
	"fmt"
	"testing"
	"time"
)

// TestSortByMtimeAscending 淘汰按 mtime 升序（最旧优先删），顺序错就会删掉新图。
func TestSortByMtimeAscending(t *testing.T) {
	base := time.Now()
	in := []cacheEntry{
		{p: "c", size: 3, mtime: base.Add(3 * time.Second).UnixMilli()},
		{p: "a", size: 1, mtime: base.UnixMilli()},
		{p: "d", size: 4, mtime: base.Add(3 * time.Second).UnixMilli()}, // 重复 mtime
		{p: "b", size: 2, mtime: base.Add(1 * time.Second).UnixMilli()},
	}
	sortByMtime(in)
	want := []string{"a", "b", "c", "d"} // 重复 mtime 保持相对顺序（sort.Slice 不保证稳定，这里只要求升序）
	for i := 1; i < len(in); i++ {
		if in[i].mtime < in[i-1].mtime {
			t.Fatalf("第 %d 项 mtime 小于前一项：顺序未升序", i)
		}
	}
	if in[0].p != want[0] || in[1].p != want[1] {
		t.Fatalf("最旧的两项应为 a,b，实际 %s,%s", in[0].p, in[1].p)
	}
}

// BenchmarkSortByMtime 6 万条（2GB 缓存 / 每张约 30KB）的排序成本。
// 用插入排序时这里是上亿次比较，一次淘汰要几十秒。
func BenchmarkSortByMtime(b *testing.B) {
	const n = 60000
	base := time.Now().UnixMilli()
	src := make([]cacheEntry, n)
	for i := range src {
		// 打乱：让元素与目标顺序相反，避免「本来就近乎有序」掩盖复杂度
		src[i] = cacheEntry{p: fmt.Sprint(i), size: 30000, mtime: base + int64(n-i)}
	}
	buf := make([]cacheEntry, n)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		copy(buf, src)
		sortByMtime(buf)
	}
}
