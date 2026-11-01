// 肥牛漫画服务端。
// 入口：装配 API + 静态伺服前端产物，单容器同时伺服 /api/* 与静态文件。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"crypto/rand"
	"encoding/hex"
	"encoding/json"

	// 内嵌 IANA 时区库：镜像用 FROM scratch（无 tzdata 包），
	// 否则 TZ=Asia/Shanghai 会静默退化成 UTC，影响日志与时间戳可读性。
	_ "time/tzdata"

	"fakenews-comics/internal/auth"
	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/gate"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/images"
	"fakenews-comics/internal/logger"
	"fakenews-comics/internal/routes"
	"fakenews-comics/internal/scanner"
	"fakenews-comics/internal/sources"
	"fakenews-comics/internal/version"
)

// init 注册 PWA 清单的 MIME。
// Go 的 mime 内建表里没有 .webmanifest，Windows 上还会先查注册表（同样没有），
// 于是一路退化成 http.ServeFile 的内容嗅探（text/plain）——部分浏览器会因此
// 判定「清单类型不合法」而忽略整个 PWA 配置，图标名与独立窗口全部失效。
func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// configureMemory 落实所有内存相关旋钮（并发闸 / 解码上限 / 缓存字节上限 / 软内存上限）。
//
// 为什么需要软内存上限：Go 的 GC 目标是「堆比存活量翻倍」，容器里没上限时
// 会一路长到接近物理内存；设了 GOMEMLIMIT 后 GC 会更早介入，RSS 被压在容器额度内，
// 用户看 docker stats 才不会看到「只涨不落」。默认取容器 cgroup 上限的 55%，
// 用户显式设了 GOMEMLIMIT 或 MEMORY_LIMIT_MB 时以用户为准。
func configureMemory(e env.Env) {
	gate.ConfigureImageGate(e.ImgConcurrency)
	gate.StartMemoryReclaimer()
	images.ConfigureDecodeLimit(e.MaxDecodeMP)
	images.ConfigureMemCacheBytes(e.MemCacheMB)
	sources.ConfigurePDF(e.PDFRenderScale, e.PDFPageCacheMB)

	limit := int64(e.MemoryLimitMB) * 1024 * 1024
	source := "MEMORY_LIMIT_MB"
	if limit <= 0 {
		if os.Getenv("GOMEMLIMIT") != "" {
			// Go 运行时自己会读 GOMEMLIMIT，这里不覆盖
			logger.Info("memory limit from GOMEMLIMIT env")
			logSoftLimitSettings(e)
			return
		}
		total := cgroupMemoryLimit()
		if total <= 0 {
			logSoftLimitSettings(e)
			return
		}
		limit = total * 55 / 100
		source = "cgroup 55%"
	}
	if limit < 128*1024*1024 {
		limit = 128 * 1024 * 1024 // 太小会让 GC 抖动，给个地板
	}
	debug.SetMemoryLimit(limit)
	logger.Info("soft memory limit set",
		"limitMB", limit/1024/1024, "source", source)
	logSoftLimitSettings(e)
}

func logSoftLimitSettings(e env.Env) {
	logger.Info("image pipeline limits",
		"imgConcurrency", gate.ImageConcurrency(),
		"maxDecodeMP", images.DecodeLimitPixels()/1000000,
		"memCacheMB", e.MemCacheMB,
		"pdfRenderScale", sources.PDFRenderScale(),
		"pdfPageCacheMB", sources.PDFPageCacheBytes()/1024/1024)
}

// cgroupMemoryLimit 读容器内存上限（v2 优先、回落 v1）；无限制/不可读返回 0。
func cgroupMemoryLimit() int64 {
	for _, p := range []string{
		"/sys/fs/cgroup/memory.max",                   // cgroup v2
		"/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
	} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		s := strings.TrimSpace(string(b))
		if s == "" || s == "max" {
			return 0
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			return 0
		}
		if n > 1<<60 { // v1 无限制时是天文数字
			return 0
		}
		return n
	}
	return 0
}

// seedFlagKey 默认库引导标记（只引导一次：容器 restart 不重复建库）。
const seedFlagKey = "defaultLibrarySeeded"

func main() {
	// -healthcheck：容器健康检查专用入口。
	// 镜像基于 FROM scratch（无 shell / curl / wget），HEALTHCHECK 只能让二进制自检，
	// 顺带省掉基础镜像（安装时镜像构建变成纯 COPY，秒级且零联网）。
	healthcheck := flag.Bool("healthcheck", false, "probe /api/health on localhost and exit 0/1")
	flag.Parse()
	if *healthcheck {
		os.Exit(runHealthcheck())
	}

	e := env.Load()
	logger.Init(e.LogLevel)
	configureMemory(e)
	if err := os.MkdirAll(e.CacheDir, 0o755); err != nil {
		logger.Error("mkdir cache dir", "err", err)
		os.Exit(1)
	}
	d := db.Get(e) // 建库 + schema
	// 源文件内容变化后让派生缩略图/自动封面一起作废（扫描器不直接依赖 images）
	scanner.OnSourceChanged = func(comicID string) {
		images.InvalidateComicCache(e, comicID)
	}
	// 旧版把自定义封面母图放在缓存目录，清理缓存会丢；搬到 DataDir（幂等）
	if n := images.MigrateCustomCovers(e); n > 0 {
		logger.Info("custom covers moved out of cache dir", "count", n)
	}
	ensureDefaultLibrary(d, e)
	auth.PruneSessions(e) // 启动清一次过期会话

	mux := http.NewServeMux()
	routes.Register(mux, e)
	registerStatic(mux, e)

	srv := &http.Server{
		Addr: fmt.Sprintf("%s:%d", e.Host, e.Port),
		// 顺序：Compress 在最外层，让 401/500 这类信封也走压缩与 ETag 逻辑；
		// 它只碰 /api/ 的 JSON，静态资源（已预压缩 .gz）原样透传。
		Handler:           httputil.Compress(routes.CSRFGate(routes.AuthGate(e)(mux))),
		ReadHeaderTimeout: 15 * time.Second,
	}

	go func() {
		logger.Info("fakenews-comics listening",
			"addr", srv.Addr, "comicRoot", e.ComicRoot, "version", version.AppVersion)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	// 启动时自动扫一次（有库才有内容）+ 按设置启动自动扫描定时器（0 = 关闭）
	scanner.TriggerScan(e, scanner.ScanOptions{})
	scanner.ScheduleAutoScan(e)

	// 优雅退出：SIGTERM（fnOS 停止应用）给在途请求 10s 收尾
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown", "err", err)
	}
}

// registerStatic 前端产物伺服（WEB_DIST 环境变量优先，缺省 <db 目录>/../web-dist）。
// SPA fallback 语义：
//   - /api/* 未命中 → JSON 404（不兜底成 HTML）
//   - 带扩展名的静态文件存在则直出，缺失保持 404（避免 js/css 被兜成 HTML 报 MIME 错）
//   - 无扩展名路径回退 index.html（SPA 路由）
func registerStatic(mux *http.ServeMux, e env.Env) {
	webDist := os.Getenv("WEB_DIST")
	if webDist == "" {
		webDist = filepath.Join(filepath.Dir(e.DBFile), "..", "web-dist")
	}
	webDist = filepath.Clean(webDist)
	if _, err := os.Stat(filepath.Join(webDist, "index.html")); err != nil {
		logger.Warn("web dist not found, SPA disabled", "dir", webDist)
		return
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			httputil.WriteError(w, http.StatusNotFound, 4040, "not found")
			return
		}
		// 路径穿越防护：Clean 后必须仍位于 webDist 内
		p := filepath.Join(webDist, filepath.Clean("/"+r.URL.Path))
		if p != webDist && !strings.HasPrefix(p, webDist+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			serveStaticFile(w, r, p)
			return
		}
		if filepath.Ext(r.URL.Path) != "" {
			http.NotFound(w, r)
			return
		}
		serveStaticFile(w, r, filepath.Join(webDist, "index.html"))
	})
}

// serveStaticFile 伺服静态文件，命中预压缩 `.gz` 兄弟文件时直出压缩内容。
// 预压缩静态资源直出：运行时零压缩开销，
// 构建期由 tools/precompress.mjs 生成 .gz（首屏 JS 235KB → 75KB）。
// 缓存策略：
//   - assets/ 下带内容指纹的产物 → 一年 immutable
//   - index.html → no-cache（升级后不会卡在旧入口）
func serveStaticFile(w http.ResponseWriter, r *http.Request, p string) {
	slashPath := filepath.ToSlash(p)
	base := filepath.Base(p)
	switch {
	case strings.Contains(slashPath, "/assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	// index.html → no-cache：升级后不会卡在旧入口
	// sw.js       → no-cache：Service Worker 必须每次回源校验，否则「升级后旧 SW 还在跑」
	case base == "index.html", base == "sw.js":
		w.Header().Set("Cache-Control", "no-cache")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		if gz, err := os.Stat(p + ".gz"); err == nil && !gz.IsDir() {
			if ct := mime.TypeByExtension(filepath.Ext(p)); ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			http.ServeFile(w, r, p+".gz")
			return
		}
	}
	http.ServeFile(w, r, p)
}

// ensureDefaultLibrary 首次运行引导：库表为空时基于 COMIC_ROOT 自动创建默认库。
// 只引导一次（settings 记账）：否则容器 restart 会把用户刚删掉的库重建回来。
func ensureDefaultLibrary(d *db.DB, e env.Env) {
	if row, _ := d.Prepare("SELECT value FROM settings WHERE key = ?").Get(seedFlagKey); row != nil {
		return
	}
	if row, _ := d.Prepare("SELECT COUNT(*) AS n FROM libraries").Get(); row != nil && db.AsInt(row, "n") == 0 {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		id := hex.EncodeToString(b[0:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" +
			hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" + hex.EncodeToString(b[10:16])
		paths, _ := json.Marshal([]string{e.ComicRoot})
		if _, err := d.Prepare("INSERT INTO libraries (id, name, type, paths, sort, created_at) VALUES (?, ?, ?, ?, 0, ?)").
			Run(id, "我的漫画", "chapter", string(paths), time.Now().UnixMilli()); err == nil {
			logger.Info("default library created at " + e.ComicRoot)
		}
	}
	flag, _ := json.Marshal(time.Now().UnixMilli())
	_, _ = d.Prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").
		Run(seedFlagKey, string(flag))
}

// runHealthcheck 请求本机 /api/health，返回进程退出码（0 健康 / 1 不健康）。
func runHealthcheck() int {
	port := os.Getenv("APP_PORT")
	if port == "" {
		port = "3000"
	}
	if _, err := strconv.Atoi(port); err != nil {
		return 1
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

var _ = httputil.WriteData
