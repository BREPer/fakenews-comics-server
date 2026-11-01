// 自动扫描调度：按设置的「自动扫描间隔」（小时）周期性触发增量扫描。
// 0 = 关闭（仅手动）。设置变更后由 settings 路由调用 ScheduleAutoScan 重排，无需重启。
// 扫描本身有串行队列（scanner/index.go），重复触发不会并发。
// 自动扫描调度。
package scanner

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/logger"
)

var (
	// 设置保存是「PUT 后立即重排」，并发请求会同时进来；
	// 没有这把锁时两个 goroutine 可能 close 同一个 done channel → panic
	autoMu         sync.Mutex
	autoTimer      *time.Ticker
	autoTimerDone  chan struct{}
	autoHoursCache = float64(-1)
)

// ReadAutoScanHours 读取当前设置值（小时；0 = 关闭）。
func ReadAutoScanHours(e env.Env) float64 {
	if row, err := db.Get(e).Prepare("SELECT value FROM settings WHERE key = 'autoScanIntervalHours'").Get(); err == nil && row != nil {
		if n, ok := parseJSONFloat(db.AsString(row, "value")); ok && n >= 0 {
			return n
		}
	}
	return 0
}

// ScheduleAutoScan 按当前设置重排定时器（值未变时不动作）。
func ScheduleAutoScan(e env.Env) {
	autoMu.Lock()
	defer autoMu.Unlock()
	hours := ReadAutoScanHours(e)
	if hours == autoHoursCache {
		return
	}
	autoHoursCache = hours
	stopAutoScanLocked()
	if hours <= 0 {
		logger.Info("auto-scan: disabled")
		return
	}
	// 下限 1 秒：防止设置成极小值导致扫描风暴（正常配置是 6h/24h）
	ms := int64(hours * 3600_000)
	if ms < 1000 {
		ms = 1000
	}
	t := time.NewTicker(time.Duration(ms) * time.Millisecond)
	done := make(chan struct{})
	autoTimer = t
	autoTimerDone = done
	go func() {
		for {
			select {
			case <-t.C:
				logger.Info("auto-scan: trigger")
				TriggerScan(e, ScanOptions{})
			case <-done:
				return
			}
		}
	}()
	logger.Info(fmt.Sprintf("auto-scan: every %gh", hours))
}

// StopAutoScan 停止调度（测试/关闭用）。
func StopAutoScan() {
	autoMu.Lock()
	defer autoMu.Unlock()
	stopAutoScanLocked()
}

// stopAutoScanLocked 调用方必须持有 autoMu。
func stopAutoScanLocked() {
	if autoTimer != nil {
		autoTimer.Stop()
		autoTimer = nil
	}
	if autoTimerDone != nil {
		close(autoTimerDone)
		autoTimerDone = nil
	}
	autoHoursCache = -1
}

func parseJSONFloat(s string) (float64, bool) {
	var n float64
	if err := json.Unmarshal([]byte(s), &n); err != nil {
		return 0, false
	}
	return n, true
}
