// 图像缓存治理：缩略图/封面磁盘缓存的统计、上限淘汰、手动清理，以及内存层 LRU。
// 缓存目录结构 / 淘汰策略 / 记账方式。
//
// 缩略图输出为 JPEG（stdlib image/jpeg）——
// 前端只按 Content-Type 消费，协议无感知；换来零原生依赖与可交叉编译。
package images

import (
	"container/list"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

type cacheEntry struct {
	p     string
	size  int64
	mtime int64
}

// CacheStats 缓存统计（字段名沿用 camelCase 契约）。
type CacheStats struct {
	TotalBytes        int64 `json:"totalBytes"`
	Files             int   `json:"files"`
	LimitBytes        int64 `json:"limitBytes"`
	ThumbsBytes       int64 `json:"thumbsBytes"`
	CoversBytes       int64 `json:"coversBytes"`
	CustomCoversBytes int64 `json:"customCoversBytes"`
}

func rootsOf(e env.Env) (thumbs, covers, custom string) {
	return filepath.Join(e.CacheDir, "thumbs"),
		filepath.Join(e.CacheDir, "covers"),
		filepath.Join(e.CacheDir, "covers-custom")
}

func walk(dir string, out *[]cacheEntry) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, en := range entries {
		p := filepath.Join(dir, en.Name())
		if en.IsDir() {
			walk(p, out)
			continue
		}
		if st, err := os.Stat(p); err == nil {
			*out = append(*out, cacheEntry{p: p, size: st.Size(), mtime: st.ModTime().UnixMilli()})
		}
	}
}

func collect(e env.Env) (entries []cacheEntry, thumbs, covers, custom int64) {
	td, cd, ud := rootsOf(e)
	var ts, cs, us []cacheEntry
	walk(td, &ts)
	walk(cd, &cs)
	walk(ud, &us)
	for _, x := range ts {
		thumbs += x.size
	}
	for _, x := range cs {
		covers += x.size
	}
	for _, x := range us {
		custom += x.size
	}
	return append(append(ts, cs...), us...), thumbs, covers, custom
}

// CacheLimitBytes 当前上限：settings.thumbnailCacheMB → env.thumbCacheMB。
func CacheLimitBytes(e env.Env) int64 {
	if row, err := db.Get(e).Prepare("SELECT value FROM settings WHERE key = 'thumbnailCacheMB'").Get(); err == nil && row != nil {
		if n, ok := toInt64(row["value"]); ok && n > 0 {
			return n * 1024 * 1024
		}
	}
	return int64(e.ThumbCacheMB) * 1024 * 1024
}

// GetCacheStats 缓存统计。
func GetCacheStats(e env.Env) CacheStats {
	entries, thumbs, covers, custom := collect(e)
	var total int64
	for _, x := range entries {
		total += x.size
	}
	return CacheStats{
		TotalBytes:        total,
		Files:             len(entries),
		LimitBytes:        CacheLimitBytes(e),
		ThumbsBytes:       thumbs,
		CoversBytes:       covers,
		CustomCoversBytes: custom,
	}
}

var (
	trackedMu    sync.Mutex
	trackedBytes int64
	trackedInit  bool
	lastEvictAt  time.Time
)

// evictMinInterval 两次淘汰的最小间隔。
//
// 一次批量生成缩略图（打开一话 = 几十张）会连着写几十个文件，每次都判定超限就
// 每次都全量 walk 三棵缓存树 + 排序 —— 整体退化成 O(写入数 × 文件数)。
// 淘汰本身已经删到 85%，新写入的这点量在几百毫秒内不会把水位再推超，
// 所以 2 秒内的重复触发直接跳过。
const evictMinInterval = 2 * time.Second

// NoteCacheWrite 每次写盘后调用：累计用量，超限触发淘汰（带节流）。
func NoteCacheWrite(e env.Env, bytes int64) {
	trackedMu.Lock()
	if !trackedInit {
		trackedBytes = GetCacheStats(e).TotalBytes
		trackedInit = true
	}
	trackedBytes += bytes
	over := trackedBytes > CacheLimitBytes(e)
	throttled := over && time.Since(lastEvictAt) < evictMinInterval
	if over && !throttled {
		lastEvictAt = time.Now()
	}
	trackedMu.Unlock()
	if over && !throttled {
		_, _ = Evict(e)
	}
}

// Evict 超限淘汰：按 mtime 最旧优先删到 85%，始终保留最新的 8 个。
func Evict(e env.Env) (freed int64, deleted int) {
	limit := CacheLimitBytes(e)
	target := limit * 85 / 100
	entries, _, _, _ := collect(e)
	// 按 mtime 升序
	sortByMtime(entries)
	keepNewest := 8
	deletable := entries
	if len(deletable) > keepNewest {
		deletable = deletable[:len(deletable)-keepNewest]
	}
	var total int64
	for _, x := range entries {
		total += x.size
	}
	for _, x := range deletable {
		if total <= target {
			break
		}
		if err := os.Remove(x.p); err == nil {
			total -= x.size
			freed += x.size
			deleted++
		}
	}
	trackedMu.Lock()
	trackedBytes = total
	trackedInit = true
	trackedMu.Unlock()
	td, cd, ud := rootsOf(e)
	pruneEmptyDirs(td)
	pruneEmptyDirs(cd)
	pruneEmptyDirs(ud)
	return freed, deleted
}

// ClearCache 清空全部缓存，返回释放字节数。
func ClearCache(e env.Env) int64 {
	var freed int64
	td, cd, ud := rootsOf(e)
	for _, d := range []string{td, cd, ud} {
		freed += rmTree(d)
	}
	trackedMu.Lock()
	trackedBytes = 0
	trackedInit = true
	trackedMu.Unlock()
	MemClear()
	return freed
}

func rmTree(dir string) int64 {
	var freed int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, en := range entries {
		p := filepath.Join(dir, en.Name())
		if en.IsDir() {
			freed += rmTree(p)
			continue
		}
		if st, err := os.Stat(p); err == nil {
			freed += st.Size()
			_ = os.Remove(p)
		}
	}
	_ = os.Remove(dir) // 非空时失败，忽略
	return freed
}

// pruneEmptyDirs 递归删空目录（保留根）。
func pruneEmptyDirs(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, en := range entries {
		if en.IsDir() {
			pruneEmptyDirs(filepath.Join(dir, en.Name()))
		}
	}
	if left, err := os.ReadDir(dir); err == nil && len(left) == 0 {
		_ = os.Remove(dir)
	}
}

func sortByMtime(entries []cacheEntry) {
	// 必须用 O(n log n)。原实现是插入排序，注释按「几千条」估的，但缓存上限可到
	// 数 GB：2GB / 每张 30KB ≈ 6 万条 → 比较次数上亿，一次淘汰要跑几十秒，
	// 期间所有取图请求都被拖住。
	sort.Slice(entries, func(i, j int) bool { return entries[i].mtime < entries[j].mtime })
}

func toInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case float64:
		return int64(t), true
	case string:
		return 0, false
	default:
		return 0, false
	}
}

/* ---------------- 渲染去重（并发同一个 key 只算一次） ---------------- */

var inFlight sync.Map // key → *inflightCall

type inflightCall struct {
	done chan struct{}
	val  any
	err  error
}

// WithInFlight 同一张图在「滑动预加载 + 当前页渲染」时会被同时请求两次以上，
// 冷缓存下每次都要读源 + 缩放 + 编码。这里按 key 合并同期待办：后来的请求
// 直接复用第一个请求的结果，渲染完成后即出表。
func WithInFlight[T any](key string, fn func() (T, error)) (T, error) {
	var zero T
	if v, ok := inFlight.Load(key); ok {
		call := v.(*inflightCall)
		<-call.done
		if call.err != nil {
			return zero, call.err
		}
		return call.val.(T), nil
	}
	call := &inflightCall{done: make(chan struct{})}
	inFlight.Store(key, call)
	func() {
		defer close(call.done)
		defer inFlight.Delete(key)
		call.val, call.err = fn()
	}()
	if call.err != nil {
		return zero, call.err
	}
	return call.val.(T), nil
}

/* ---------------- 内存层 LRU（缩略图热数据，按字节 + 条数双上限） ---------------- */

const (
	memMaxEntries = 256
	// memMaxBytesDefault 内存层默认上限 32MB。
	// 为什么不只按条数：封面 640px JPEG 能到 100KB+，256 条可能吃掉 25MB+，
	// 而小缩略图 256 条只有几 MB——按字节才是真实的内存约束。
	memMaxBytesDefault = 32 << 20
)

type memEntry struct {
	key string
	buf []byte
}

var (
	memMu    sync.Mutex
	memLRU   = list.New() // front = 最近使用
	memIndex = map[string]*list.Element{}
	memBytes int64
	memLimit = int64(memMaxBytesDefault)
)

// ConfigureMemCacheBytes 设置内存层字节上限（MB，<=0 用默认）。幂等。
func ConfigureMemCacheBytes(mb int) {
	memMu.Lock()
	defer memMu.Unlock()
	if mb > 0 {
		memLimit = int64(mb) * 1024 * 1024
	}
}

// MemGet 取内存缓存（命中即提到队首）。
func MemGet(key string) ([]byte, bool) {
	memMu.Lock()
	defer memMu.Unlock()
	el, ok := memIndex[key]
	if !ok {
		return nil, false
	}
	memLRU.MoveToFront(el)
	return el.Value.(*memEntry).buf, true
}

// MemSet 写入内存缓存（超字节或条数上限时从队尾淘汰）。
func MemSet(key string, buf []byte) {
	memMu.Lock()
	defer memMu.Unlock()
	if el, ok := memIndex[key]; ok {
		e := el.Value.(*memEntry)
		memBytes += int64(len(buf)) - int64(len(e.buf))
		e.buf = buf
		memLRU.MoveToFront(el)
	} else {
		memIndex[key] = memLRU.PushFront(&memEntry{key: key, buf: buf})
		memBytes += int64(len(buf))
	}
	// 至少留 1 条：否则单个超大条目会把刚写入的自己淘汰掉
	for memLRU.Len() > memMaxEntries || (memBytes > memLimit && memLRU.Len() > 1) {
		back := memLRU.Back()
		e := back.Value.(*memEntry)
		memLRU.Remove(back)
		delete(memIndex, e.key)
		memBytes -= int64(len(e.buf))
	}
}

// MemClear 清空内存缓存。
func MemClear() {
	memMu.Lock()
	defer memMu.Unlock()
	memLRU.Init()
	memIndex = map[string]*list.Element{}
	memBytes = 0
}

// MemDeletePrefix 丢弃指定路径前缀的内存条目（源文件变更时按漫画目录清理）。
func MemDeletePrefix(prefix string) {
	memMu.Lock()
	defer memMu.Unlock()
	for key, el := range memIndex {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		memLRU.Remove(el)
		delete(memIndex, key)
		memBytes -= int64(len(el.Value.(*memEntry).buf))
	}
}

// InvalidateComicCache 源文件换了内容后丢弃它的派生缩略图与自动封面。
// 自定义封面（DataDir 母图 + covers-custom 派生）是用户选择，不在这里清。
func InvalidateComicCache(e env.Env, comicID string) {
	for _, dir := range []string{
		filepath.Join(e.CacheDir, "thumbs", comicID),
		filepath.Join(e.CacheDir, "covers", comicID),
	} {
		MemDeletePrefix(dir + string(os.PathSeparator))
		_ = os.RemoveAll(dir)
	}
}

// MemSize 当前条数。
func MemSize() int {
	memMu.Lock()
	defer memMu.Unlock()
	return memLRU.Len()
}

// MemBytes 当前占用字节数（自检/测试用）。
func MemBytes() int64 {
	memMu.Lock()
	defer memMu.Unlock()
	return memBytes
}
