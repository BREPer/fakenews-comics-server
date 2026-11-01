// 源工厂：按格式 → ComicSource，每漫画一个长生命周期源句柄的缓存。
// 缓存 key 含「文件版本」（mtime+size）与章视图，压缩包被原地替换后不会读到旧内容。
// 源缓存：TTL 10 分钟、上限 24 个。
package sources

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

const (
	sourceTTL      = 10 * time.Minute
	sourceCacheMax = 24
)

type sourceEntry struct {
	at  time.Time
	src ComicSource
}

// closeGrace 被驱逐的源延迟多久才真正 Close。
//
// 为什么不能立刻 Close：源实例是**共享**的 —— goroutine A 从缓存拿到 src 正在
// ListPages()/GetPageStream()，goroutine B 因为打开了新书触发驱逐，直接把 A 手里
// 那个 src 关掉，A 就会读到已关闭的文件（偶发「某页 500」）。
// 单次取图远不会超过 1 分钟，所以延迟一个宽限期关闭即可，不必引入引用计数。
var closeGrace = time.Minute

type closingEntry struct {
	src ComicSource
	at  time.Time
}

var (
	sourceCache   = map[string]*sourceEntry{}
	sourceCacheMu sync.Mutex
	// pendingClose 已从缓存移除、等待宽限期后真正关闭的源
	pendingClose []closingEntry
	// openingSources 正在打开中的 key（去重并发首次打开）
	openingSources = map[string]*openCall{}
)

// openCall 一次「正在打开」的调用：等待者读 done 后取 src/err。
type openCall struct {
	done chan struct{}
	src  ComicSource
	err  error
}

// pendingCloseMax 延迟关闭队列上限。持续驱逐却迟迟不到宽限期时（例如库很大、
// 用户连续打开不同漫画），强制先关最旧的一个，避免句柄堆积。
const pendingCloseMax = 64

// retireLocked 把源移入延迟关闭队列（调用方需持锁）。
func retireLocked(src ComicSource, now time.Time) {
	if len(pendingClose) >= pendingCloseMax {
		oldest := 0
		for i := range pendingClose {
			if pendingClose[i].at.Before(pendingClose[oldest].at) {
				oldest = i
			}
		}
		pendingClose[oldest].src.Close()
		pendingClose = append(pendingClose[:oldest], pendingClose[oldest+1:]...)
	}
	pendingClose = append(pendingClose, closingEntry{src: src, at: now})
}

// flushRetiredLocked 关闭已过宽限期的源（调用方需持锁）。
func flushRetiredLocked(now time.Time) {
	if len(pendingClose) == 0 {
		return
	}
	keep := pendingClose[:0]
	for _, e := range pendingClose {
		if now.Sub(e.at) >= closeGrace {
			e.src.Close()
			continue
		}
		keep = append(keep, e)
	}
	pendingClose = keep
}

func sourceEvictLocked() {
	now := time.Now()
	flushRetiredLocked(now)
	for k, v := range sourceCache {
		if now.Sub(v.at) > sourceTTL {
			retireLocked(v.src, now)
			delete(sourceCache, k)
		}
	}
	for len(sourceCache) >= sourceCacheMax {
		oldest := ""
		var oldestAt time.Time
		for k, v := range sourceCache {
			if oldest == "" || v.at.Before(oldestAt) {
				oldest, oldestAt = k, v.at
			}
		}
		if oldest == "" {
			break
		}
		retireLocked(sourceCache[oldest].src, now)
		delete(sourceCache, oldest)
	}
}

// OpenSource 打开（或复用缓存的）源。
//
// 三条路径：
//   1. 缓存命中 —— 持锁只做一次 map 查找（很快）；
//   2. 已有别的 goroutine 正在打开同一个 key —— 等它，避免同一本书被并发
//      zip.OpenReader 好几次（阅读器预加载会同时发 6 个请求）；
//   3. 都没有 —— **放锁**真正打开（可能几十毫秒），再持锁写回。
//
// 以前整段都持 sourceCacheMu，包括打开压缩包，于是并发取图全部串行在一个锁上。
func OpenSource(p, ext string, opts OpenSourceOptions) (ComicSource, error) {
	key := sourceKey(p, ext, opts)

	sourceCacheMu.Lock()
	sourceEvictLocked()
	if hit, ok := sourceCache[key]; ok {
		hit.at = time.Now()
		src := hit.src
		sourceCacheMu.Unlock()
		return src, nil
	}
	if call, ok := openingSources[key]; ok {
		sourceCacheMu.Unlock()
		<-call.done
		return call.src, call.err
	}
	call := &openCall{done: make(chan struct{})}
	openingSources[key] = call
	sourceCacheMu.Unlock()

	src, err := openSourceRaw(p, ext, opts)

	sourceCacheMu.Lock()
	delete(openingSources, key)
	if err == nil {
		// 打开期间别人可能塞进缓存了（并发打开不同 key 时不会，但保险）
		sourceCache[key] = &sourceEntry{at: time.Now(), src: src}
	}
	call.src, call.err = src, err
	close(call.done)
	sourceCacheMu.Unlock()
	return src, err
}

// sourceKey 缓存键：格式 + 路径 + 版本戳(mtime+size) + 视图(prefix/topOnly)。
// 文件被替换时 mtime/size 变，旧句柄自然失效。
func sourceKey(p, ext string, opts OpenSourceOptions) string {
	stamp := ""
	if st, err := os.Stat(p); err == nil {
		stamp = fmt.Sprintf(":%d:%d", st.ModTime().UnixMilli(), st.Size())
	}
	view := ""
	if opts.Prefix != "" {
		view = "#" + opts.Prefix
	} else if opts.TopOnly {
		view = "#top"
	}
	return ext + ":" + p + stamp + view
}

// openSourceRaw 真正打开源（不持锁、不查缓存）。
func openSourceRaw(p, ext string, opts OpenSourceOptions) (ComicSource, error) {
	var src ComicSource
	switch ext {
	case "zip", "cbz", "epub":
		z, err := OpenZip(p, ext, opts)
		if err != nil {
			var nf *notFoundError
			if errors.As(err, &nf) {
				return nil, &SourceError{Status: 404, Msg: "archive not found: " + p}
			}
			return nil, &SourceError{Status: 415, Msg: fmt.Sprintf("cannot open archive (%s): %v", ext, err)}
		}
		src = z
	case "rar", "cbr":
		r, err := OpenRar(p, ext, opts)
		if err != nil {
			var nf *notFoundError
			if errors.As(err, &nf) {
				return nil, &SourceError{Status: 404, Msg: "archive not found: " + p}
			}
			return nil, &SourceError{Status: 415, Msg: fmt.Sprintf("cannot open archive (%s): %v", ext, err)}
		}
		src = r
	case "tar", "cbt":
		t, err := OpenTar(p, ext, opts)
		if err != nil {
			var nf *notFoundError
			if errors.As(err, &nf) {
				return nil, &SourceError{Status: 404, Msg: "archive not found: " + p}
			}
			return nil, &SourceError{Status: 415, Msg: fmt.Sprintf("cannot open archive (%s): %v", ext, err)}
		}
		src = t
	case "pdf":
		ps, err := OpenPdf(p)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &SourceError{Status: 404, Msg: "pdf not found: " + p}
			}
			return nil, &SourceError{Status: 415, Msg: fmt.Sprintf("cannot open pdf: %v", err)}
		}
		src = ps
	case "folder", "":
		f, err := OpenFolder(p, opts)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, &SourceError{Status: 404, Msg: "folder not found: " + p}
			}
			return nil, &SourceError{Status: 415, Msg: fmt.Sprintf("cannot open folder: %v", err)}
		}
		src = f
	default:
		return nil, &SourceError{Status: 415, Msg: "unsupported format: " + ext}
	}
	return src, nil
}

// CloseAllSources 关闭全部缓存源（进程退出/测试清理用）。
func CloseAllSources() {
	sourceCacheMu.Lock()
	defer sourceCacheMu.Unlock()
	for _, v := range sourceCache {
		v.src.Close()
	}
	sourceCache = map[string]*sourceEntry{}
}

/* ---------------- 错误类型 ---------------- */

// SourceError 带 HTTP 状态的源错误（415 坏包/404 不存在）。
type SourceError struct {
	Status int
	Msg    string
}

func (e *SourceError) Error() string { return e.Msg }

type notFoundError struct{ path string }

func (e *notFoundError) Error() string { return "not found: " + e.path }
