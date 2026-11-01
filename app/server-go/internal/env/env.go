// Package env 环境变量解析：所有运行期配置集中在此，缺省值对齐 fpk 向导默认值。
// 环境变量字段命名与语义。
//
// 内存相关旋钮（2026-10-22 内存收尾新增）也在这里，避免默认值散落在各个包里：
//   IMG_CONCURRENCY    同时解码/光栅化的图像数（默认 2）
//   MAX_DECODE_MP      单张图解码像素上限，百万像素（默认 60）
//   MEM_CACHE_MB       缩略图内存层字节上限（默认 32）
//   PDF_RENDER_SCALE   PDF 渲染倍率，相对 pt（默认 2）
//   PDF_PAGE_CACHE_MB  单个 PDF 原图页缓存字节上限（默认 64）
//   MEMORY_LIMIT_MB    Go 软内存上限（默认 0 = 按容器 cgroup 上限自动取 55%）
package env

import (
	"os"
	"path/filepath"
	"strconv"
)

// Env 运行期配置。
type Env struct {
	Port         int
	Host         string
	ComicRoot    string // 漫画根目录（向导收集，卷挂载点）
	DataDir      string // 数据目录（db / cache）
	DBFile       string
	CacheDir     string
	ThumbCacheMB int
	LogLevel     string

	// 内存与并发（见文件头说明）
	ImgConcurrency   int
	MaxDecodeMP      int
	MemCacheMB       int
	PDFRenderScale   float64
	PDFPageCacheMB   int
	MemoryLimitMB    int
}

func envInt(key string, dflt int) int {
	n, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return dflt
	}
	return n
}

func envFloat(key string, dflt float64) float64 {
	f, err := strconv.ParseFloat(os.Getenv(key), 64)
	if err != nil || f <= 0 {
		return dflt
	}
	return f
}

func getenvDefault(key, dflt string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return dflt
}

// Load 读取环境变量并应用缺省值。
func Load() Env {
	dataDir := getenvDefault("DATA_DIR", "/data")
	return Env{
		Port:         envInt("APP_PORT", 3000),
		Host:         getenvDefault("HOST", "0.0.0.0"),
		ComicRoot:    getenvDefault("COMIC_ROOT", "/comics"),
		DataDir:      dataDir,
		DBFile:       getenvDefault("DB_FILE", filepath.Join(dataDir, "db", "fakenews-comics.db")),
		CacheDir:     getenvDefault("CACHE_DIR", filepath.Join(dataDir, "cache")),
		ThumbCacheMB: envInt("THUMB_CACHE_MB", 2048),
		LogLevel:     getenvDefault("LOG_LEVEL", "info"),

		ImgConcurrency: envInt("IMG_CONCURRENCY", 2),
		MaxDecodeMP:    envInt("MAX_DECODE_MP", 60),
		MemCacheMB:     envInt("MEM_CACHE_MB", 32),
		PDFRenderScale: envFloat("PDF_RENDER_SCALE", 2),
		PDFPageCacheMB: envInt("PDF_PAGE_CACHE_MB", 64),
		MemoryLimitMB:  envInt("MEMORY_LIMIT_MB", 0),
	}
}
