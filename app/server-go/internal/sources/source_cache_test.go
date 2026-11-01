// 源缓存的驱逐语义：不得关闭可能正在被别的请求使用的源。
package sources

import (
	"sync/atomic"
	"testing"
	"time"
)

// fakeSource 只关心 Close 次数。
type fakeSource struct {
	closes int32
}

func (f *fakeSource) Format() string                         { return "zip" }
func (f *fakeSource) ListPages() ([]PageEntry, error)        { return nil, nil }
func (f *fakeSource) ListChapters() ([]SourceChapter, error) { return nil, nil }
func (f *fakeSource) ReadMetadata() (*SourceMetadata, error) { return nil, nil }
func (f *fakeSource) GetPageStream(int, PageStreamOptions) (*PageStream, error) {
	return nil, nil
}
func (f *fakeSource) Close() { atomic.AddInt32(&f.closes, 1) }

func (f *fakeSource) closeCount() int { return int(atomic.LoadInt32(&f.closes)) }

// resetSourceCache 清空缓存状态（避免测试间互相影响）。
func resetSourceCache() {
	sourceCacheMu.Lock()
	defer sourceCacheMu.Unlock()
	for _, e := range sourceCache {
		e.src.Close()
	}
	sourceCache = map[string]*sourceEntry{}
	for _, e := range pendingClose {
		e.src.Close()
	}
	pendingClose = nil
}

// TestEvictDefersClose 驱逐时不能立刻 Close：源实例是共享的，另一个 goroutine
// 可能正拿着它读页，立刻 Close 会让那次请求读到已关闭的文件（偶发「某页 500」）。
func TestEvictDefersClose(t *testing.T) {
	resetSourceCache()
	defer resetSourceCache()

	src := &fakeSource{}
	sourceCacheMu.Lock()
	sourceCache["victim"] = &sourceEntry{at: time.Now().Add(-2 * sourceTTL), src: src} // 已过期
	sourceEvictLocked()
	gone := len(sourceCache)
	pending := len(pendingClose)
	sourceCacheMu.Unlock()

	if gone != 0 {
		t.Fatalf("过期源应被移出缓存，实际还剩 %d", gone)
	}
	if pending != 1 {
		t.Fatalf("应进入延迟关闭队列 1 个，实际 %d", pending)
	}
	if n := src.closeCount(); n != 0 {
		t.Fatalf("驱逐时不应立即 Close（正在被使用的请求会失败），Close 次数 = %d", n)
	}
}

// TestRetiredSourceClosedAfterGrace 宽限期过后必须真正关闭，否则句柄泄漏。
func TestRetiredSourceClosedAfterGrace(t *testing.T) {
	resetSourceCache()
	defer resetSourceCache()

	src := &fakeSource{}
	now := time.Now()
	sourceCacheMu.Lock()
	retireLocked(src, now.Add(-2*closeGrace)) // 已经超过宽限期
	flushRetiredLocked(now)
	left := len(pendingClose)
	sourceCacheMu.Unlock()

	if left != 0 {
		t.Fatalf("过了宽限期应被清出队列，实际剩 %d", left)
	}
	if n := src.closeCount(); n != 1 {
		t.Fatalf("过了宽限期应关闭 1 次，实际 %d", n)
	}
}

// TestPendingCloseBounded 队列满时强制关闭最旧的，避免长时间不关导致句柄堆积。
func TestPendingCloseBounded(t *testing.T) {
	resetSourceCache()
	defer resetSourceCache()

	now := time.Now()
	srcs := make([]*fakeSource, pendingCloseMax+5)
	sourceCacheMu.Lock()
	for i := range srcs {
		srcs[i] = &fakeSource{}
		retireLocked(srcs[i], now.Add(time.Duration(i)*time.Millisecond))
	}
	size := len(pendingClose)
	sourceCacheMu.Unlock()

	if size != pendingCloseMax {
		t.Fatalf("队列长度应被限制在 %d，实际 %d", pendingCloseMax, size)
	}
	if n := srcs[0].closeCount(); n != 1 {
		t.Fatalf("最旧的一个应被强制关闭，Close 次数 = %d", n)
	}
	if n := srcs[len(srcs)-1].closeCount(); n != 0 {
		t.Fatalf("刚入队的应仍在等待宽限期，Close 次数 = %d", n)
	}
}
