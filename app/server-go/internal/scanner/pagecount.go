// 章页数缓存。
//
// 详情页（GET /api/comics/{id}）需要每章的页数，而 buildChapters 对 folder 型的
// 子目录章 / 顶层打包章只填 0（构建时不解压、不遍历），于是 routes 层每次请求都要
// 为每一章重新数一遍：folder 章走目录遍历、压缩包章读中央目录。
//
// 一部 500 章的漫画 = 500 次文件系统操作，**每次打开详情都重来**（章节列表本身有
// 8s 缓存，但页数没有）。这里按「路径 + 格式 + 前缀 + topOnly + 路径 mtime」缓存：
// 文件/目录被替换时 mtime 变化会自动失效，不需要 TTL 兜底。
package scanner

import (
	"os"
	"sync"

	"fakenews-comics/internal/sources"
)

const pageCountCacheMax = 4096

type pageCountEntry struct {
	mtime int64
	n     int
}

var (
	pageCountCache   = map[string]*pageCountEntry{}
	pageCountCacheMu sync.Mutex
)

// ClearPageCountCache 清空页数缓存（扫描 / 单部重扫后调用）。
func ClearPageCountCache() {
	pageCountCacheMu.Lock()
	defer pageCountCacheMu.Unlock()
	pageCountCache = map[string]*pageCountEntry{}
}

// PageCountOf 返回一章的页数（带 mtime 校验的进程内缓存）。
//
// 计数失败返回 0 且**不写缓存**——0 也可能是「临时读不到」（NAS 抖动、权限），
// 缓存住会让详情页一直显示 0 页，下次请求应当重试。
func PageCountOf(path, format, prefix string, topOnly bool) int {
	key := path + "|" + format + "|" + prefix
	if topOnly {
		key += "|top"
	}
	var mtime int64
	if st, err := os.Stat(path); err == nil {
		mtime = st.ModTime().UnixMilli()
	}

	pageCountCacheMu.Lock()
	if e, ok := pageCountCache[key]; ok && e.mtime == mtime {
		n := e.n
		pageCountCacheMu.Unlock()
		return n
	}
	pageCountCacheMu.Unlock()

	n := countPagesOf(path, format, prefix, topOnly)
	if n <= 0 {
		return n
	}

	pageCountCacheMu.Lock()
	if len(pageCountCache) >= pageCountCacheMax {
		// 简单淘汰：删任意一条即可（缓存只是加速，丢了会重算，不影响正确性）
		for k := range pageCountCache {
			delete(pageCountCache, k)
			break
		}
	}
	pageCountCache[key] = &pageCountEntry{mtime: mtime, n: n}
	pageCountCacheMu.Unlock()
	return n
}

// countPagesOf folder 走目录遍历；压缩包走 ListPages（只读中央目录，不解压全文）。
func countPagesOf(path, format, prefix string, topOnly bool) int {
	if format == "" || format == "folder" {
		if topOnly {
			return len(sources.ListTopImages(path))
		}
		return len(sources.ListFolderImages(path))
	}
	src, err := sources.OpenSource(path, format, sources.OpenSourceOptions{Prefix: prefix, TopOnly: topOnly})
	if err != nil {
		return 0
	}
	pages, err := src.ListPages()
	if err != nil {
		return 0
	}
	return len(pages)
}
