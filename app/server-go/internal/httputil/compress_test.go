package httputil

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(h http.Handler, method, path string, hdr map[string]string) *http.Response {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

// 大 JSON + Accept-Encoding: gzip → 压缩且可解回原文，并带弱 ETag
func TestCompressGzipJSON(t *testing.T) {
	h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"items": strings.Repeat("漫画", 400)})
	}))
	res := serve(h, http.MethodGet, "/api/comics", map[string]string{"Accept-Encoding": "gzip"})
	if got := res.Header.Get("content-encoding"); got != "gzip" {
		t.Fatalf("content-encoding = %q, want gzip", got)
	}
	if !strings.Contains(res.Header.Get("vary"), "Accept-Encoding") {
		t.Fatalf("vary = %q, want Accept-Encoding", res.Header.Get("vary"))
	}
	etag := res.Header.Get("etag")
	if !strings.HasPrefix(etag, `W/"`) || strings.Contains(etag, " ") {
		t.Fatalf("etag = %q, want weak form W/\"…\"", etag)
	}
	if !strings.HasSuffix(etag, `-gz"`) {
		t.Fatalf("etag = %q, gzip 表示应带 -gz 后缀", etag)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !bytes.Contains(plain, []byte("items")) {
		t.Fatalf("解压后内容不对: %.80s", plain)
	}
}

// 命中 If-None-Match → 304、无 body
func TestCompressETagNotModified(t *testing.T) {
	h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"items": strings.Repeat("漫画", 400)})
	}))
	first := serve(h, http.MethodGet, "/api/comics", map[string]string{"Accept-Encoding": "gzip"})
	etag := first.Header.Get("etag")
	if etag == "" {
		t.Fatal("首个响应缺 etag")
	}
	second := serve(h, http.MethodGet, "/api/comics", map[string]string{
		"Accept-Encoding": "gzip",
		"If-None-Match":   etag,
	})
	if second.StatusCode != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", second.StatusCode)
	}
	body, _ := io.ReadAll(second.Body)
	if len(body) != 0 {
		t.Fatalf("304 不应有 body，得到 %d 字节", len(body))
	}
	// identity 变体的 ETag 必须与 gzip 变体不同（否则会串包）
	third := serve(h, http.MethodGet, "/api/comics", nil)
	if third.Header.Get("etag") == etag {
		t.Fatalf("identity 与 gzip 的 etag 不能相同: %q", etag)
	}
}

// 小响应不压缩（省 CPU 且压完更大）
func TestCompressSkipsSmallBody(t *testing.T) {
	h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteData(w, map[string]any{"ok": true})
	}))
	res := serve(h, http.MethodGet, "/api/progress", map[string]string{"Accept-Encoding": "gzip"})
	if enc := res.Header.Get("content-encoding"); enc != "" {
		t.Fatalf("小响应不应压缩，content-encoding = %q", enc)
	}
	if res.Header.Get("etag") == "" {
		t.Fatal("小响应仍应带 etag（304 同样省 RTT）")
	}
}

// 图片 / 206 / 非 /api 路径一律不碰
func TestCompressPassthrough(t *testing.T) {
	png := bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 500)
	cases := []struct {
		name     string
		path     string
		status   int
		ct       string
		hdr      map[string]string
		explicit bool // 是否显式 WriteHeader（封面/页面流实际是隐式 200）
	}{
		{"image", "/api/comics/x/cover", http.StatusOK, "image/png", nil, false},
		{"range", "/api/comics/x/chapters/y/pages/1", http.StatusPartialContent, "image/jpeg", nil, true},
		{"static", "/assets/app.js", http.StatusOK, "text/javascript", nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", c.ct)
				if c.status == http.StatusPartialContent {
					w.Header().Set("content-range", "bytes 0-1999/9999")
				}
				if c.explicit {
					w.WriteHeader(c.status)
				}
				_, _ = w.Write(png)
			}))
			res := serve(h, http.MethodGet, c.path, map[string]string{"Accept-Encoding": "gzip"})
			if enc := res.Header.Get("content-encoding"); enc != "" {
				t.Fatalf("不应压缩，content-encoding = %q", enc)
			}
			if res.Header.Get("etag") != "" {
				t.Fatalf("不应加 etag: %q", res.Header.Get("etag"))
			}
			got, _ := io.ReadAll(res.Body)
			if !bytes.Equal(got, png) {
				t.Fatalf("字节被改写：%d → %d", len(png), len(got))
			}
		})
	}
}

// 客户端不接受 gzip → 原样明文，但仍可带 ETag 做 304
func TestCompressIdentityClient(t *testing.T) {
	h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"items": strings.Repeat("漫画", 400)})
	}))
	res := serve(h, http.MethodGet, "/api/comics", nil)
	if enc := res.Header.Get("content-encoding"); enc != "" {
		t.Fatalf("content-encoding = %q, 应为空", enc)
	}
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("items")) {
		t.Fatalf("明文 body 异常: %.80s", body)
	}
}

// 写请求不挂 ETag / Cache-Control（重试与缓存语义对非幂等请求没有意义）
func TestCompressNoValidatorOnWrite(t *testing.T) {
	h := Compress(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteData(w, map[string]any{"ok": true})
	}))
	res := serve(h, http.MethodPost, "/api/scan", map[string]string{"Accept-Encoding": "gzip"})
	if res.Header.Get("etag") != "" {
		t.Fatalf("POST 不应带 etag: %q", res.Header.Get("etag"))
	}
	if cc := res.Header.Get("cache-control"); cc != "" {
		t.Fatalf("POST 不应带 cache-control: %q", cc)
	}
}

func TestEtagMatches(t *testing.T) {
	etag := `W/"abc-gz"`
	yes := []string{`W/"abc-gz"`, `"abc-gz"`, `*`, `W/"other", W/"abc-gz"`, ` W/"abc-gz" `}
	for _, v := range yes {
		if !EtagMatches(v, etag) {
			t.Errorf("EtagMatches(%q) 应为 true", v)
		}
	}
	no := []string{"", `W/"abc"`, `W/"abc-gz-x"`}
	for _, v := range no {
		if EtagMatches(v, etag) {
			t.Errorf("EtagMatches(%q) 应为 false", v)
		}
	}
}
