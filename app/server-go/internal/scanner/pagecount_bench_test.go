package scanner

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkPageCountOf 衡量详情页回填每章页数的成本：
// cold = 每章都重新遍历目录（修复前的行为），warm = 命中 mtime 缓存。
// 造 200 章 × 20 图（真实中长篇漫画的规模）。
func BenchmarkPageCountOf(b *testing.B) {
	root := b.TempDir()
	dirs := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		d := filepath.Join(root, fmt.Sprintf("ch%03d", i))
		if err := os.MkdirAll(d, 0o755); err != nil {
			b.Fatalf("mkdir: %v", err)
		}
		for j := 0; j < 20; j++ {
			if err := os.WriteFile(filepath.Join(d, fmt.Sprintf("%03d.jpg", j)), []byte("x"), 0o644); err != nil {
				b.Fatalf("write: %v", err)
			}
		}
		dirs = append(dirs, d)
	}

	b.Run("cold", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			ClearPageCountCache()
			for _, d := range dirs {
				PageCountOf(d, "folder", "", false)
			}
		}
	})

	b.Run("warm", func(b *testing.B) {
		ClearPageCountCache()
		for _, d := range dirs { // 预热
			PageCountOf(d, "folder", "", false)
		}
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, d := range dirs {
				PageCountOf(d, "folder", "", false)
			}
		}
	})
}
