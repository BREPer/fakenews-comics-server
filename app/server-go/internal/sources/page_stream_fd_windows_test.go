//go:build windows

package sources

import (
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

// handleCount 取当前进程的句柄数（kernel32!GetProcessHandleCount）。
func handleCount(t *testing.T) int {
	t.Helper()
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	// 必须用 GetCurrentProcess() 的伪句柄（-1），传 pid 会得到 ERROR_INVALID_HANDLE
	self, _, _ := kernel32.NewProc("GetCurrentProcess").Call()
	var n uint32
	r, _, err := kernel32.NewProc("GetProcessHandleCount").Call(self, uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		t.Fatalf("GetProcessHandleCount 失败: %v", err)
	}
	return int(n)
}

// TestFolderPageStreamNoFDLeak 连续取页 300 次，句柄数不得随之增长。
//
// 回归背景：folder 源每次取页 os.Open 一个句柄，但 PageStream 没有 Close 字段，
// 句柄只能等 GC 的 finalizer 回收。真实使用中「翻几百页」后进程 fd 耗尽（EMFILE），
// NAS 上表现为整站 500。修复后 Closer 由 handler defer 关闭，句柄数应保持平稳。
func TestFolderPageStreamNoFDLeak(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "001.jpg"), []byte("leak-check-payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := OpenFolder(dir, OpenSourceOptions{})
	if err != nil {
		t.Fatalf("open folder: %v", err)
	}
	if _, err := src.ListPages(); err != nil {
		t.Fatalf("ListPages: %v", err)
	}

	const rounds = 300
	base := handleCount(t)
	for i := 0; i < rounds; i++ {
		ps, err := src.GetPageStream(0, PageStreamOptions{})
		if err != nil {
			t.Fatalf("round %d: %v", i, err)
		}
		if _, err := io.Copy(io.Discard, ps.Stream); err != nil {
			t.Fatalf("round %d 读取: %v", i, err)
		}
		if ps.Closer != nil {
			if err := ps.Closer.Close(); err != nil {
				t.Fatalf("round %d Close: %v", i, err)
			}
		}
	}
	after := handleCount(t)

	// 允许少量波动（测试框架自身可能开句柄），但不允许随次数线性增长
	if grew := after - base; grew > 20 {
		t.Fatalf("取页 %d 次后句柄 %d -> %d（+%d），疑似 fd 泄漏", rounds, base, after, grew)
	} else {
		t.Logf("取页 %d 次：句柄 %d -> %d（+%d），无泄漏", rounds, base, after, grew)
	}
}
