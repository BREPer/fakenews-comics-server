// 响应编码层：/api 的 JSON 响应做 gzip 压缩 + 弱 ETag 协商缓存。
//
// 为什么需要（实测数据，tools/perf_audit.mjs）：
//   GET /api/comics?pageSize=120 → 58,517B 未压缩，gzip 后 5,711B（-90%）
//   GET /api/history?limit=100   → 60,294B 未压缩
// 静态资源一直有预压缩 .gz + immutable，唯独 API 是裸 JSON —— 慢网下首页那一个
// 请求就是几百毫秒的纯搬运时间。这里补上运行时压缩，顺带补 API 一直没有的缓存验证。
//
// 只处理 /api/ 且 content-type 为 JSON/文本、状态 200 的响应：
//   - 图片（封面 / 页面流）本身已压缩，再压是白烧 CPU，且 pages 接口要支持 Range
//   - 206 / 带 content-range 的响应绝不能改字节数
//   - 已有 content-encoding 的（预压缩静态文件）不再二次编码
// 小于 gzipMinSize 的响应不压：gzip 头尾固定 18 字节，`{"code":0,...}` 这种小包
// 压完反而更大，纯亏 CPU。
package httputil

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

const (
	// compressBufferCap 参与 ETag 计算的最大响应体；超过就放弃 ETag 直接流式输出
	// （目前最大的是 /api/backup/export，正常几百 KB，8MB 足够且不至于吃掉内存）
	compressBufferCap = 8 << 20
	// gzipMinSize 低于该长度不压缩
	gzipMinSize = 1024
)

// gzipWriterPool flate.Writer 每次 Reset 前会保留约 500KB 的哈希表，
// 每请求新建在 NAS 的低功耗 CPU 上就是可观的分配压力，这里复用。
var gzipWriterPool = sync.Pool{
	New: func() any {
		w, err := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
		if err != nil {
			return nil
		}
		return w
	},
}

// Compress 包裹整站 handler：命中条件时压缩并附加 ETag。
// 放在 AuthGate 外层，未登录的 401 信封同样走压缩。
func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressWriter{ResponseWriter: w, req: r, status: http.StatusOK}
		defer cw.finish()
		next.ServeHTTP(cw, r)
	})
}

type compressWriter struct {
	http.ResponseWriter
	req    *http.Request
	status int
	buf    bytes.Buffer
	// headerSeen 记录 handler 是否显式调用过 WriteHeader；没调用时（图片接口都是
	// 直接 Write）要等到 Write 才知道 content-type，判定必须延后到那一刻
	headerSeen bool
	// sent 表示响应头已经提交给底层（直通模式 / 缓冲超限）；此后再不能改头
	sent bool
}

func (c *compressWriter) WriteHeader(code int) {
	c.headerSeen = true
	if c.sent {
		return
	}
	c.status = code
	if !c.bufferable() {
		c.sent = true
		c.ResponseWriter.WriteHeader(code)
	}
}

// bufferable 判断这条响应能否整包缓冲（关乎 ETag 与压缩）。
func (c *compressWriter) bufferable() bool {
	if c.status != http.StatusOK {
		return false
	}
	h := c.Header()
	if h.Get("content-encoding") != "" || h.Get("content-range") != "" {
		return false
	}
	return compressibleType(h.Get("content-type"))
}

func (c *compressWriter) Write(p []byte) (int, error) {
	if c.sent {
		return c.ResponseWriter.Write(p)
	}
	if !c.headerSeen {
		// 隐式 200：content-type 此时才齐（封面 / 页面流都不显式 WriteHeader），
		// 在这里补判定。漏了这步会把图片整张读进内存再算 ETag —— 页面流最大几 MB，
		// 等于给每张图都加一次无谓的分配。
		c.headerSeen = true
		if !c.bufferable() {
			c.sent = true
			c.ResponseWriter.WriteHeader(c.status)
			return c.ResponseWriter.Write(p)
		}
	}
	if c.buf.Len()+len(p) > compressBufferCap {
		// 超大响应：放弃 ETag，把已缓冲的部分连同响应头刷出去，后续直通
		c.flushPlain()
		return c.ResponseWriter.Write(p)
	}
	return c.buf.Write(p)
}

// flushPlain 提交响应头并把缓冲内容原样写出（不压缩、不带 ETag）。
func (c *compressWriter) flushPlain() {
	if c.sent {
		return
	}
	c.sent = true
	c.ResponseWriter.WriteHeader(c.status)
	if c.buf.Len() > 0 {
		_, _ = c.ResponseWriter.Write(c.buf.Bytes())
		c.buf.Reset()
	}
}

// finish 在 handler 返回后统一决定：304 / gzip / 原样。
func (c *compressWriter) finish() {
	if c.sent {
		return
	}
	body := c.buf.Bytes()
	h := c.Header()
	w := c.ResponseWriter

	if len(body) == 0 {
		c.sent = true
		w.WriteHeader(c.status)
		return
	}

	gz := acceptsGzip(c.req) && len(body) >= gzipMinSize
	isRead := c.req.Method == http.MethodGet || c.req.Method == http.MethodHead

	// 只有读请求才谈协商缓存：PUT/POST 的响应浏览器本来就不会复用，
	// 给它们挂 ETag/Cache-Control 只会让响应头说谎。
	if isRead {
		// ETag 带上编码后缀：同一份数据在 identity / gzip 两种表示下字节不同，
		// 不加后缀会让「先拿 gzip、后拿 identity」的客户端收到不该有的 304。
		etag := weakETag(body, gz)
		h.Set("etag", etag)
		h.Set("vary", "Accept-Encoding")
		if h.Get("cache-control") == "" {
			// no-cache = 允许缓存但每次必须回源验证，正好配合 ETag 拿 304。
			// 注意不是 no-store：那样浏览器连存都不存，ETag 就白算了。
			h.Set("cache-control", "no-cache")
		}
		if EtagMatches(c.req.Header.Get("if-none-match"), etag) {
			h.Del("content-length")
			h.Del("content-encoding")
			c.sent = true
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}

	if !gz {
		// 长度已知：显式给 content-length，浏览器不必等 chunked 结束才知道总量
		h.Set("content-length", strconv.Itoa(len(body)))
		c.sent = true
		w.WriteHeader(c.status)
		_, _ = w.Write(body)
		return
	}

	h.Set("content-encoding", "gzip")
	h.Del("content-length")
	c.sent = true
	w.WriteHeader(c.status)
	zw, _ := gzipWriterPool.Get().(*gzip.Writer)
	if zw == nil {
		// 极端情况下 pool 里拿不到 writer：退回未压缩输出，宁可大一点也不能丢响应
		h.Del("content-encoding")
		_, _ = w.Write(body)
		return
	}
	zw.Reset(w)
	_, _ = zw.Write(body)
	_ = zw.Close()
	zw.Reset(io.Discard)
	gzipWriterPool.Put(zw)
}

// acceptsGzip 客户端是否接受 gzip。
// 只做包含判断（不解析 q=0）：浏览器不会对 gzip 发 q=0，
// 而 curl / 各类 SDK 的 `gzip, deflate, br` 都能被这行覆盖。
func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// compressibleType 只对 JSON / 文本压缩；图片、字体、压缩包一律不动。
func compressibleType(ct string) bool {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	if ct == "application/json" {
		return true
	}
	return strings.HasPrefix(ct, "text/") && ct != "text/event-stream"
}

func weakETag(body []byte, gzipEncoded bool) string {
	sum := sha256.Sum256(body)
	s := hex.EncodeToString(sum[:8])
	if gzipEncoded {
		s += "-gz"
	}
	return `W/"` + s + `"`
}

// EtagMatches 判定 If-None-Match 是否命中（支持 `*` 与逗号分隔列表，弱比较）。
func EtagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	want := strings.TrimPrefix(strings.TrimSpace(etag), "W/")
	for _, part := range strings.Split(ifNoneMatch, ",") {
		v := strings.TrimSpace(part)
		if v == "*" {
			return true
		}
		if strings.TrimPrefix(v, "W/") == want {
			return true
		}
	}
	return false
}
