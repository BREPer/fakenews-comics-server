// Package logger 统一日志：slog 文本格式，级别可调。
// 日志：info 以上默认输出，debug 时输出请求细节。
package logger

import (
	"log/slog"
	"os"
	"strings"
)

var L *slog.Logger

// Init 按级别初始化全局 logger（debug/info/warn/error，非法值回落 info）。
func Init(level string) {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	L = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lv}))
	slog.SetDefault(L)
}

func init() {
	// 默认 info 级：测试/未显式初始化的进程也不会 nil panic
	if L == nil {
		L = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	}
}

func Info(msg string, args ...any)  { L.Info(msg, args...) }
func Warn(msg string, args ...any)  { L.Warn(msg, args...) }
func Error(msg string, args ...any) { L.Error(msg, args...) }
func Debug(msg string, args ...any) { L.Debug(msg, args...) }
