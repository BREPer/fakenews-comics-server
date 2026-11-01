// 健康检查与关于信息路由。
// /api/health 供 fnOS cmd/main 探活；/api/about 供设置页「关于」与「装了旧包」排查。
package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/version"
)

var startedAt = time.Now()

func registerHealth(mux *http.ServeMux, e env.Env) {
	mux.HandleFunc("GET /api/health", adapt(func(w http.ResponseWriter, r *http.Request) error {
		httputil.WriteData(w, map[string]any{
			"ok":      true,
			"ts":      time.Now().UnixMilli(),
			"name":    version.AppName,
			"version": version.AppVersion,
		})
		return nil
	}))

	mux.HandleFunc("GET /api/about", adapt(func(w http.ResponseWriter, r *http.Request) error {
		httputil.WriteData(w, map[string]any{
			"name":         version.AppName,
			"version":      version.AppVersion,
			"builtAt":      buildTime(),
			"node":         runtime.Version(),
			"platform":     runtime.GOOS + "/" + runtime.GOARCH,
			"port":         e.Port,
			"uptimeSec":    int64(time.Since(startedAt).Seconds()),
			"comicRoot":    e.ComicRoot,
			"dataDir":      e.DataDir,
			"dataWritable": dirWritable(e.DataDir),
			"dbFile":       e.DBFile,
			"dbBytes":      fileSize(e.DBFile) + fileSize(e.DBFile+"-wal"),
		})
		return nil
	}))
}

// buildTime 取可执行文件 mtime。
func buildTime() int64 {
	exe, err := os.Executable()
	if err != nil {
		return startedAt.UnixMilli()
	}
	return fileModTime(exe)
}

func fileModTime(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.ModTime().UnixMilli()
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

// dirWritable 数据目录可写性检测（fnOS 卷权限问题一眼看出）。
func dirWritable(dir string) bool {
	probe := filepath.Join(dir, ".fakenews-write-probe")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	f, err := os.Create(probe)
	if err != nil {
		return false
	}
	_ = f.Close()
	_ = os.Remove(probe)
	return true
}
