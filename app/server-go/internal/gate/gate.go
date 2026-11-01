// Package gate —— 图像解码/渲染的全局并发闸与内存回收。
//
// 为什么需要（2026-10-22 实测）：
//   Go 的 image 解码必须一次分配整张位图。4000×6000 的页解码后是 96MB RGBA，
//   首屏 12 张封面并发 = 1.8GB，翻页再叠 6 路直接冲到 3.6GB（RSS）。
//   这不是泄漏，但会把 NAS 顶爆——libvips 靠 shrink-on-load 躲过去的事，
//   纯 Go 只能靠「限制同时解码的个数」。
//
// 闸门只覆盖 decode/scale/encode 与 PDF 光栅化，持锁时间是毫秒级；
// 缓存命中的读取路径不经过它，因此热路径无额外延迟。
package gate

import (
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// defaultImageConcurrency 默认同时解码/渲染的图像数。
	// 2 是「NAS 安全 + 首屏可接受」的折中：24MP 页约 96MB/张，2 路≈200MB 峰值。
	defaultImageConcurrency = 2
	// freeOSInterval FreeOSMemory 的最小间隔（防抖：避免每次渲染都抖动 GC）。
	freeOSInterval = 5 * time.Second
)

var (
	gateOnce  sync.Once
	imageGate chan struct{}
	gateCap   int

	freeMu       sync.Mutex
	lastFree     time.Time
	lastActivity atomic.Int64 // 最近一次图像任务结束的时间（unix nano）
)

// ConfigureImageGate 设置并发上限（<=0 用默认值）。幂等：重复调用以首次为准。
func ConfigureImageGate(capacity int) {
	gateOnce.Do(func() {
		if capacity <= 0 {
			capacity = defaultImageConcurrency
		}
		gateCap = capacity
		imageGate = make(chan struct{}, capacity)
	})
}

// ImageConcurrency 当前并发上限（未配置时返回默认值）。
func ImageConcurrency() int {
	ConfigureImageGate(0)
	return gateCap
}

// AcquireImageSlot 取一个解码/渲染槽位，满则排队等待。
// 返回的释放函数**必须**调用（defer），否则闸门会被永久占住。
func AcquireImageSlot() func() {
	ConfigureImageGate(0)
	imageGate <- struct{}{}
	return func() {
		<-imageGate
		maybeReleaseOSMemory()
	}
}

// StartMemoryReclaimer 启动后台归还器：空闲时把已释放的堆还给操作系统。
//
// 与 release 钩子互补：
//   - release 钩子（5s 防抖）压**爆发期**的高水位
//   - 本回收器兜**爆发结束后**的回落（没有请求就不会再有 release 钩子触发）
//
// 判据用「空闲时长」而不是「HeapAlloc/Sys 比值」：没有 GC 时 HeapAlloc 不会自己降，
// 用比值会互相等待（实测踩过：收尾 12s 一直是 382MB 不回落）。
// 空闲 3s 才动手，避免在持续浏览时反复 FreeOSMemory（每次都会 STW）。
func StartMemoryReclaimer() {
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			if len(imageGate) > 0 { // 还有活要干
				continue
			}
			if time.Since(time.Unix(0, lastActivity.Load())) < 3*time.Second {
				continue
			}
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			if m.Sys < 96<<20 { // 本来就不大，不值得折腾
				continue
			}
			freeMu.Lock()
			if time.Since(lastFree) < freeOSInterval {
				freeMu.Unlock()
				continue
			}
			lastFree = time.Now()
			freeMu.Unlock()
			debug.FreeOSMemory()
		}
	}()
}

// bigImagePixels 超过这个像素数（16MP ≈ 64MB 位图）的大图**独占**解码。
// 理由：解码内存与像素线性相关，用「个数」限流时，2 张 24MP 图 = 192MB 活对象，
// 再加分配器保留就冲到 GB 级；改成大图串行后，普通扫描件（4-6MP）仍两路并发，
// 超大跨页扫（24MP）一次只解一张。
const bigImagePixels = 16 * 1000 * 1000

var bigMu sync.Mutex

// AcquireImageSlotFor 按像素数取槽位：大图额外串行化。
// pixels<=0 表示未知，按大图处理（保守）。
func AcquireImageSlotFor(pixels int64) func() {
	release := AcquireImageSlot()
	if pixels <= 0 || pixels > bigImagePixels {
		bigMu.Lock()
		return func() {
			bigMu.Unlock()
			release()
		}
	}
	return release
}

// maybeReleaseOSMemory 防抖地把已释放的堆还给操作系统（最多 5s 一次）。
//
// 为什么不在「完全空闲」时才做：持续浏览（预加载 + 翻页接连不断）时队列几乎从不空，
// 只在空闲时归还会让 RSS 一直停在高水位——用户看 docker stats 会以为内存「只涨不落」。
// 实测（tools/mem_probe_go.mjs）：加上这条后爆发期峰值也从 479MB 压到 ~300MB。
//
// 5s 防抖是为了避免频繁 stop-the-world：FreeOSMemory 会触发一次完整 GC。
func maybeReleaseOSMemory() {
	lastActivity.Store(time.Now().UnixNano())
	freeMu.Lock()
	if time.Since(lastFree) < freeOSInterval {
		freeMu.Unlock()
		return
	}
	lastFree = time.Now()
	freeMu.Unlock()
	go debug.FreeOSMemory()
}
