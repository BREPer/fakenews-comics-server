// 扫描编排：增量比对 + 分片任务 + 章节模型（权威实现）。
// 扫描编排：
//   - 增量：SELECT 全量进内存比对，mtime 未变跳过；META_VERSION 变更触发全量重解析
//   - 安全阀：根目录不可访问时整库跳过（卷未挂载不误删）
//   - 章节模型：folder 散图章→子目录章→打包章；zip 包内一级目录分组；epub 整本按 spine
//   - chapterCache：详情页/取图共用，8s TTL，返回副本防污染
package scanner

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/logger"
	"fakenews-comics/internal/sources"
)

// META_VERSION 元数据解析规则版本；变更解析逻辑时 +1，触发一次全量重解析。
// v2：章节型文件夹新增识别「顶层 zip/cbz/pdf/epub 作为章节」。
const META_VERSION = 2

const metaVersionKey = "scanMetaVersion"

// OnSourceChanged 源文件新增/内容变化并成功入库后调用（main 注入缓存失效）。
// 用回调而不是直接依赖 images：images 依赖 scanner，直接反向引用会成环。
var OnSourceChanged func(comicID string)

// IDFromPath 路径 → 稳定 id（sha1 前 16 位）：重扫不变、移动即新书。
func IDFromPath(p string) string {
	sum := sha1.Sum([]byte(p))
	return hex.EncodeToString(sum[:])[:16]
}

// ChapterInfo 章信息（详情页/阅读器消费）。
type ChapterInfo struct {
	ID        string `json:"id"`
	Index     int    `json:"index"`
	Title     string `json:"title"`
	PageCount int    `json:"pageCount"`
	SizeBytes int64  `json:"sizeBytes"`
	// 章的读取入口：folder 型 = 章目录；zip 型 = 压缩包文件；文件夹内打包章 = 该文件路径
	Path string `json:"path"`
	// 章自身的源格式：folder 子目录/散图章 = 'folder'；文件夹内 zip/cbz/pdf/epub 章 = 扩展名
	Format string `json:"format,omitempty"`
	// zip 型：包内章目录名（配合 Path 定位章内页）
	Prefix string `json:"prefix,omitempty"`
	// folder 型混合结构：本图为散图章，只读顶层图片
	TopOnly bool `json:"topOnly,omitempty"`
}

/* ---------------- 章节模型（权威） ---------------- */

const (
	chapterCacheMax = 200
	chapterTTL      = 8 * time.Second
)

type chapterCacheEntry struct {
	at    time.Time
	mtime int64
	list  []ChapterInfo
}

var (
	chapterCache   = map[string]*chapterCacheEntry{}
	chapterCacheMu sync.Mutex
)

// ClearChapterCache 清空章列表缓存（扫描/单部重扫后调用）。
func ClearChapterCache() {
	chapterCacheMu.Lock()
	defer chapterCacheMu.Unlock()
	chapterCache = map[string]*chapterCacheEntry{}
	// 章列表变了，页数也可能变（新增/删除章、替换压缩包）——一并清掉
	ClearPageCountCache()
}

// ListChapters 列出某漫画的章（带 8s 缓存；返回副本防调用方回填污染）。
func ListChapters(comicPath, format, comicID string, chapterLib bool) ([]ChapterInfo, error) {
	var mtime int64
	if st, err := os.Stat(comicPath); err == nil {
		mtime = st.ModTime().UnixMilli()
	}
	key := comicID + "|" + comicPath
	if chapterLib {
		key += "|1"
	}
	chapterCacheMu.Lock()
	if hit, ok := chapterCache[key]; ok && hit.mtime == mtime && time.Since(hit.at) < chapterTTL {
		out := cloneChapters(hit.list)
		chapterCacheMu.Unlock()
		return out, nil
	}
	chapterCacheMu.Unlock()

	list, err := buildChapters(comicPath, format, comicID, chapterLib)
	if err != nil {
		return nil, err
	}
	chapterCacheMu.Lock()
	if len(chapterCache) >= chapterCacheMax {
		for k := range chapterCache {
			delete(chapterCache, k)
			break
		}
	}
	chapterCache[key] = &chapterCacheEntry{at: time.Now(), mtime: mtime, list: list}
	chapterCacheMu.Unlock()
	return cloneChapters(list), nil
}

func cloneChapters(in []ChapterInfo) []ChapterInfo {
	out := make([]ChapterInfo, len(in))
	copy(out, in)
	return out
}

// buildChapters 章节模型权威实现（对照 TS buildChapters 逐分支）。
func buildChapters(comicPath, format, comicID string, chapterLib bool) ([]ChapterInfo, error) {
	var out []ChapterInfo

	// 单篇型：整本书一章，扁平收集所有图片（folder 递归 / archive 整包）
	if !chapterLib {
		title := sources.ParseName(filepath.Base(comicPath)).Title
		if format == "folder" {
			imgs := sources.ListFolderImages(comicPath)
			if len(imgs) > 0 {
				out = append(out, ChapterInfo{
					ID: comicID + "#0", Index: 0, Title: title,
					PageCount: len(imgs), SizeBytes: safeSize(comicPath),
					Path: comicPath, Format: "folder",
				})
			}
		} else {
			src, err := sources.OpenSource(comicPath, format, sources.OpenSourceOptions{})
			if err == nil {
				pages, err := src.ListPages()
				if err == nil && len(pages) > 0 {
					out = append(out, ChapterInfo{
						ID: comicID + "#0", Index: 0, Title: title,
						PageCount: len(pages), SizeBytes: safeSize(comicPath),
						Path: comicPath,
					})
				}
			}
		}
		return out, nil
	}

	// 章节型
	if format == "folder" {
		dirs := sources.NaturalSort(sources.SubDirsOf(comicPath), func(s string) string { return s })
		looseTop := sources.ListTopImages(comicPath)
		archives := sources.NaturalSort(TopArchivesOf(comicPath), func(s string) string { return s })
		if len(dirs) > 0 || len(archives) > 0 {
			index := 0
			// 混合结构：顶层散图先成一章
			if len(looseTop) > 0 {
				out = append(out, ChapterInfo{
					ID: comicID + "#0", Index: 0,
					Title:     sources.ParseName(filepath.Base(comicPath)).Title,
					PageCount: len(looseTop), SizeBytes: 0,
					Path: comicPath, Format: "folder", TopOnly: true,
				})
				index = 1
			}
			// 子目录章节
			for di, name := range dirs {
				full := filepath.Join(comicPath, name)
				out = append(out, ChapterInfo{
					ID: comicID + "#" + itoa(index+di), Index: index + di,
					Title: sources.ParseName(name).Title, PageCount: 0,
					SizeBytes: safeSize(full), Path: full, Format: "folder",
				})
			}
			index += len(dirs)
			// 顶层打包章节：各自成章，用各自格式打开
			for ai, name := range archives {
				full := filepath.Join(comicPath, name)
				out = append(out, ChapterInfo{
					ID: comicID + "#" + itoa(index+ai), Index: index + ai,
					Title: sources.ParseName(name).Title, PageCount: 0,
					SizeBytes: safeSize(full), Path: full, Format: sources.ExtOf(name),
				})
			}
			return out, nil
		}
		// 无子目录也无打包文件：散图文件夹，整册一章
		if FolderHasImages(comicPath) {
			imgs := sources.ListFolderImages(comicPath)
			out = append(out, ChapterInfo{
				ID: comicID + "#0", Index: 0,
				Title:     sources.ParseName(filepath.Base(comicPath)).Title,
				PageCount: len(imgs), SizeBytes: safeSize(comicPath),
				Path: comicPath, Format: "folder",
			})
		}
		return out, nil
	}

	// zip 系：包内一级目录 = 章
	src, err := sources.OpenSource(comicPath, format, sources.OpenSourceOptions{})
	if err == nil {
		inner, err := src.ListChapters()
		if err == nil && len(inner) > 0 {
			for i, ch := range inner {
				out = append(out, ChapterInfo{
					ID: comicID + "#" + itoa(i), Index: i,
					Title: ch.Title, PageCount: ch.PageCount, SizeBytes: 0,
					Path: comicPath, Prefix: ch.ID,
				})
			}
			return out, nil
		}
	}
	// 打开失败或无内部分章：整包一章
	out = append(out, ChapterInfo{
		ID: comicID + "#0", Index: 0,
		Title: sources.ParseName(filepath.Base(comicPath)).Title, PageCount: 0,
		SizeBytes: safeSize(comicPath), Path: comicPath,
	})
	return out, nil
}

func safeSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

/* ---------------- 扫描编排 ---------------- */

// ScanStatus 扫描状态。
type ScanStatus struct {
	Running     bool     `json:"running"`
	Total       int      `json:"total"`
	Done        int      `json:"done"`
	Skipped     int      `json:"skipped"`
	FullParse   bool     `json:"fullParse"`
	SkippedLibs []string `json:"skippedLibs"`
	Current     string   `json:"current"`
	StartedAt   int64    `json:"startedAt,omitempty"`
	FinishedAt  int64    `json:"finishedAt,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// ScanOptions 扫描选项。
type ScanOptions struct {
	LibraryID string // 只扫指定库
	Full      bool   // 强制全量重解析
}

var (
	statusMu  sync.Mutex
	status    = ScanStatus{SkippedLibs: []string{}}
	scanQueue = make(chan scanJob, 64)
	scanOnce  sync.Once
)

type scanJob struct {
	env  env.Env
	opts ScanOptions
}

// GetScanStatus 当前状态快照。
func GetScanStatus() ScanStatus {
	statusMu.Lock()
	defer statusMu.Unlock()
	s := status
	s.SkippedLibs = append([]string{}, status.SkippedLibs...)
	return s
}

// TriggerScan 触发扫描（串行队列，与 TS 语义一致：排队不丢弃）。
// 两次对齐点：
//  1. 入队即置 running=true——TS 的 promise 链同步开跑，POST 返回时状态已 running；
//     否则调用方轮询 /api/scan/status 会在 worker 启动前误判扫描结束。
//  2. 已在运行时**照样入队**（TS 的 queue.then 排队语义）——运行中再触发
//     （如刚建了新库）会排到前一轮之后执行，而不是被丢弃导致新库永不扫描。
func TriggerScan(e env.Env, opts ScanOptions) {
	scanOnce.Do(func() { go scanWorker() })
	statusMu.Lock()
	if !status.Running {
		status.Running = true
		status.StartedAt = time.Now().UnixMilli()
		status.Error = ""
	}
	statusMu.Unlock()
	select {
	case scanQueue <- scanJob{env: e, opts: opts}:
	default:
		// 队列满（64 深度）：背压丢弃并告警；若此时并未真在跑，补一次直跑
		logger.Warn("scan queue full, trigger dropped")
		statusMu.Lock()
		idle := !status.Running
		statusMu.Unlock()
		if idle {
			go func() { _ = runScan(e, opts) }()
		}
	}
}

func scanWorker() {
	for job := range scanQueue {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("scan panic", "err", rec)
					statusMu.Lock()
					status.Error = "panic: " + fmtSprint(rec)
					status.Running = false
					statusMu.Unlock()
				}
			}()
			if err := runScan(job.env, job.opts); err != nil {
				logger.Error("scan failed", "err", err)
			}
		}()
	}
}

func fmtSprint(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case error:
		return t.Error()
	default:
		return "unknown"
	}
}

func runScan(e env.Env, opts ScanOptions) error {
	statusMu.Lock()
	if !status.Running {
		// 未经 TriggerScan 预热状态（测试直跑 / 内部调用）：补齐现场
		status.Running = true
		status.StartedAt = time.Now().UnixMilli()
	}
	status.Total = 0
	status.Done = 0
	status.Skipped = 0
	status.FullParse = false
	status.SkippedLibs = []string{}
	status.Current = ""
	status.Error = ""
	status.FinishedAt = 0
	statusMu.Unlock()

	defer func() {
		statusMu.Lock()
		status.Running = false
		status.FinishedAt = time.Now().UnixMilli()
		status.Current = ""
		statusMu.Unlock()
		ClearChapterCache()
		lib.InvalidateFacets()
	}()

	d := db.Get(e)

	// 1. 内存快照比对
	rows, err := d.Prepare("SELECT id, path, file_modified_at, library_id FROM comics").All()
	if err != nil {
		return err
	}
	known := map[string]map[string]any{}
	for _, r := range rows {
		known[db.AsString(r, "path")] = r
	}

	// 2. 确定要遍历的根
	libRows, err := d.Prepare("SELECT id, name, type, paths, sort FROM libraries ORDER BY sort").All()
	if err != nil {
		return err
	}
	scope := libRows
	if opts.LibraryID != "" {
		scope = nil
		for _, r := range libRows {
			if db.AsString(r, "id") == opts.LibraryID {
				scope = append(scope, r)
			}
		}
	}

	// 安全阀：根不可访问（卷未挂载/网络盘断连）整库跳过，否则消失文件清理会清空书架
	var accessibleRoots []string
	type target struct {
		row   map[string]any
		paths []string
	}
	var targets []target
	var skippedLibs []string
	for _, lr := range scope {
		var paths []string
		_ = json.Unmarshal([]byte(db.AsString(lr, "paths")), &paths)
		var ok, missing []string
		for _, root := range paths {
			if isDirAccessible(root) {
				ok = append(ok, root)
			} else {
				missing = append(missing, root)
			}
		}
		if len(missing) > 0 {
			logger.Warn("scan: 跳过不可访问的库路径 " + joinStrings(missing) + "（卷未挂载？）")
		}
		if len(ok) > 0 {
			targets = append(targets, target{row: lr, paths: ok})
			accessibleRoots = append(accessibleRoots, ok...)
		} else {
			skippedLibs = append(skippedLibs, db.AsString(lr, "name"))
		}
	}

	// 3. 收集候选
	// 同一文件可能落在嵌套库的两个根下：归属于**更具体的根**（路径更长），
	// 否则结果取决于库的 sort 顺序，重扫也纠不回来。
	type cand struct {
		c       Candidate
		lib     map[string]any
		rootLen int
	}
	var candidates []cand
	seen := map[string]int{}
	for _, tg := range targets {
		for _, root := range tg.paths {
			root := filepath.Clean(root)
			rootLen := len(root)
			WalkRoot(root, func(c Candidate) {
				// 用 Clean 归一化做键：库根可能以 `/` 存储，而 Join 出来的是 `\`，
				// 同一文件夹会被当成两个候选入库（嵌套库归属也就纠不正）。
				key := filepath.Clean(c.Path)
				if i, ok := seen[key]; ok {
					if rootLen > candidates[i].rootLen {
						candidates[i].lib = tg.row
						candidates[i].rootLen = rootLen
					}
					return
				}
				seen[key] = len(candidates)
				candidates = append(candidates, cand{c: c, lib: tg.row, rootLen: rootLen})
			}, db.AsString(tg.row, "type") == "chapter")
		}
	}

	// 4. 消失文件 → 级联清理（仅限可访问根之下）
	targetLibIDs := map[string]bool{}
	for _, tg := range targets {
		targetLibIDs[db.AsString(tg.row, "id")] = true
	}
	for p, row := range known {
		if !targetLibIDs[db.AsString(row, "library_id")] {
			continue
		}
		if _, ok := seen[filepath.Clean(p)]; ok {
			continue
		}
		if !underAnyRoot(p, accessibleRoots) {
			continue
		}
		id := db.AsString(row, "id")
		d.Prepare("DELETE FROM comics WHERE id = ?").Run(id)
		d.Prepare("DELETE FROM reading_progress WHERE comic_id = ?").Run(id)
		d.Prepare("DELETE FROM favorites WHERE comic_id = ?").Run(id)
	}

	// 5. 新增/变更 → 解析入库（分片让出事件循环）
	storedVersion := readMetaVersion(d)
	fullParse := opts.Full || storedVersion != META_VERSION
	statusMu.Lock()
	status.Total = len(candidates)
	status.FullParse = fullParse
	status.SkippedLibs = skippedLibs
	statusMu.Unlock()

	upsert := d.Prepare(`
    INSERT INTO comics (id, library_id, title, raw_title, author, description, format, path,
      size_bytes, chapter_count, page_count, tags, file_modified_at, added_at, meta_locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(path) DO UPDATE SET
      library_id = excluded.library_id,
      title = CASE WHEN meta_locked = 1 THEN comics.title ELSE excluded.title END,
      author = CASE WHEN meta_locked = 1 THEN comics.author ELSE excluded.author END,
      description = CASE WHEN meta_locked = 1 THEN comics.description ELSE excluded.description END,
      tags = CASE WHEN meta_locked = 1 THEN comics.tags ELSE excluded.tags END,
      size_bytes = excluded.size_bytes,
      chapter_count = excluded.chapter_count,
      page_count = excluded.page_count,
      file_modified_at = excluded.file_modified_at
  `)
	prevMtime := d.Prepare("SELECT file_modified_at, library_id FROM comics WHERE path = ?")
	liveLibs := d.Prepare("SELECT id FROM libraries")

	const chunk = 40
	skipped := 0
	for i := 0; i < len(candidates); i += chunk {
		end := i + chunk
		if end > len(candidates) {
			end = len(candidates)
		}
		// 长任务期间用户可能删库：只用运行时仍存在的库
		liveRows, _ := liveLibs.All()
		liveIDs := map[string]bool{}
		for _, r := range liveRows {
			liveIDs[db.AsString(r, "id")] = true
		}
		for _, cd := range candidates[i:end] {
			libID := db.AsString(cd.lib, "id")
			if !liveIDs[libID] {
				continue
			}
			statusMu.Lock()
			status.Current = cd.c.Path
			statusMu.Unlock()
			prev, _ := prevMtime.Get(cd.c.Path)
			sourceChanged := prev == nil // 新文件：清掉同路径遗留的旧缓存
			if prev != nil {
				sourceChanged = db.AsInt64(prev, "file_modified_at") != cd.c.FileModifiedAt
			}
			// 增量跳过：文件未变、库归属也没变
			if prev != nil && !fullParse && !sourceChanged &&
				db.AsString(prev, "library_id") == libID {
				skipped++
				statusMu.Lock()
				status.Skipped = skipped
				status.Done++
				statusMu.Unlock()
				continue
			}
			chapterCount, pageCount, meta := analyze(cd.c, db.AsString(cd.lib, "type") == "chapter")
			parsed := sources.ParseName(filepath.Base(cd.c.Path))
			format := cd.c.Ext
			if cd.c.Kind == "folder" {
				format = "folder"
			}
			id := IDFromPath(cd.c.Path)
			libName := db.AsString(cd.lib, "name")
			tagSet := map[string]bool{format: true, libName: true}
			if meta != nil {
				for _, g := range meta.Genre {
					tagSet[g] = true
				}
				for _, t := range meta.Tags {
					tagSet[t] = true
				}
			}
			tags := make([]string, 0, len(tagSet))
			for t := range tagSet {
				tags = append(tags, t)
			}
			tagsJSON, _ := json.Marshal(tags)
			title := parsed.Title
			if meta != nil && meta.Title != "" {
				title = meta.Title
			}
			author := sources.GuessAuthor(filepath.Base(cd.c.Path))
			if meta != nil && meta.Author != "" {
				author = meta.Author
			}
			var summary string
			if meta != nil {
				summary = meta.Summary
			}
			_, err := upsert.Run(
				id, libID, title, filepath.Base(cd.c.Path), author, summary, format, cd.c.Path,
				cd.c.SizeBytes, chapterCount, pageCount, string(tagsJSON), cd.c.FileModifiedAt, time.Now().UnixMilli(),
			)
			if err != nil {
				logger.Error("[scan] upsert failed", cd.c.Path, err)
			} else if sourceChanged && OnSourceChanged != nil {
				// 源文件换了内容：同 id 的旧缩略图/自动封面必须作废
				OnSourceChanged(id)
			}
			statusMu.Lock()
			status.Done++
			statusMu.Unlock()
		}
		time.Sleep(0) // 让出事件循环
	}

	if fullParse {
		writeMetaVersion(d, META_VERSION)
	}
	logger.Info("scan done: " + itoa(len(candidates)) + " candidates, " + itoa(skipped) + " unchanged skipped")
	return nil
}

// analyze 解析单个候选：只打开一次源，同时取元数据、页数、章数。
func analyze(c Candidate, chapterLib bool) (chapterCount, pageCount int, meta *sources.SourceMetadata) {
	chapterCount = 1
	// 共享缓存实例：不 Close（同 images 层约定）
	src, err := sources.OpenSource(c.Path, extOfCandidate(c), sources.OpenSourceOptions{})
	if err != nil {
		logger.Error("[scan] analyze failed", c.Path, err)
		return chapterCount, 0, nil
	}
	if m, err := src.ReadMetadata(); err == nil && m != nil {
		meta = m
	}
	if pages, err := src.ListPages(); err == nil {
		pageCount = len(pages)
	}
	if chapterLib {
		if c.Kind == "folder" {
			dirs := len(sources.SubDirsOf(c.Path))
			loose := 0
			if len(sources.ListTopImages(c.Path)) > 0 {
				loose = 1
			}
			archives := len(TopArchivesOf(c.Path))
			if sum := dirs + loose + archives; sum > 0 {
				chapterCount = sum
			}
		} else if chapters, err := src.ListChapters(); err == nil && len(chapters) > 0 {
			chapterCount = len(chapters)
		}
	}
	return chapterCount, pageCount, meta
}

func extOfCandidate(c Candidate) string {
	if c.Kind == "folder" {
		return "folder"
	}
	return c.Ext
}

func isDirAccessible(p string) bool {
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		return false
	}
	if _, err := os.ReadDir(p); err != nil { // 仅 stat 可能被挂载点伪造，真正读一次才可靠
		return false
	}
	return true
}

func underAnyRoot(p string, roots []string) bool {
	norm := func(x string) string {
		x = filepath.ToSlash(x)
		for len(x) > 1 && x[len(x)-1] == '/' {
			x = x[:len(x)-1]
		}
		return toLower(x)
	}
	np := norm(p)
	for _, r := range roots {
		nr := norm(r)
		if np == nr || hasPrefix(np, nr+"/") {
			return true
		}
	}
	return false
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func joinStrings(list []string) string {
	out := ""
	for i, s := range list {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}

func readMetaVersion(d *db.DB) int {
	if row, err := d.Prepare("SELECT value FROM settings WHERE key = ?").Get(metaVersionKey); err == nil && row != nil {
		if n, ok := parseJSONInt(db.AsString(row, "value")); ok {
			return n
		}
	}
	return -1
}

func writeMetaVersion(d *db.DB, v int) {
	b, _ := json.Marshal(v)
	_, _ = d.Prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").
		Run(metaVersionKey, string(b))
}

func parseJSONInt(s string) (int, bool) {
	var n int
	if err := json.Unmarshal([]byte(s), &n); err != nil {
		return 0, false
	}
	return n, true
}

/* ---------------- 单部重扫 ---------------- */

// RescanComic 只重读这一条的源结构/页数/元数据并更新（替换文件后的局部刷新）。
func RescanComic(e env.Env, comicID string) (*RescanResult, error) {
	d := db.Get(e)
	row, err := d.Prepare(`
    SELECT c.id, c.path, c.format, c.meta_locked, c.file_modified_at, l.name AS lib_name, l.type AS lib_type
    FROM comics c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?`).Get(comicID)
	if err != nil || row == nil {
		return nil, errNotFound
	}
	isFolder := db.AsString(row, "format") == "folder"
	st, err := os.Stat(db.AsString(row, "path"))
	if err != nil {
		return nil, errNotFound // 文件已消失：交给全库扫描做级联清理
	}
	fileModifiedAt := st.ModTime().UnixMilli()
	cand := Candidate{
		Path: db.AsString(row, "path"), SizeBytes: st.Size(), FileModifiedAt: fileModifiedAt,
	}
	if isFolder {
		cand.Kind = "folder"
	} else {
		cand.Kind = "file"
		cand.Ext = db.AsString(row, "format")
	}

	chapters, _ := ListChapters(cand.Path, db.AsString(row, "format"), comicID, db.AsString(row, "lib_type") == "chapter")
	chapterCount := len(chapters)
	if chapterCount == 0 {
		chapterCount = 1
	}
	pageCount := countPages(cand)
	meta := readMetadataOf(cand)
	parsed := sources.ParseName(filepath.Base(cand.Path))

	libName := db.AsString(row, "lib_name")
	tagSet := map[string]bool{db.AsString(row, "format"): true, libName: true}
	if meta != nil {
		for _, g := range meta.Genre {
			tagSet[g] = true
		}
		for _, t := range meta.Tags {
			tagSet[t] = true
		}
	}
	tags := make([]string, 0, len(tagSet))
	for t := range tagSet {
		tags = append(tags, t)
	}
	tagsJSON, _ := json.Marshal(tags)
	title := parsed.Title
	if meta != nil && meta.Title != "" {
		title = meta.Title
	}
	author := sources.GuessAuthor(filepath.Base(cand.Path))
	if meta != nil && meta.Author != "" {
		author = meta.Author
	}
	var summary string
	if meta != nil {
		summary = meta.Summary
	}
	_, err = d.Prepare(`
    UPDATE comics SET
      title = CASE WHEN meta_locked = 1 THEN title ELSE ? END,
      author = CASE WHEN meta_locked = 1 THEN author ELSE ? END,
      description = CASE WHEN meta_locked = 1 THEN description ELSE ? END,
      tags = CASE WHEN meta_locked = 1 THEN tags ELSE ? END,
      size_bytes = ?, chapter_count = ?, page_count = ?, file_modified_at = ?
    WHERE id = ?`).Run(title, author, summary, string(tagsJSON),
		st.Size(), chapterCount, pageCount, fileModifiedAt, comicID)
	if err != nil {
		return nil, err
	}
	ClearChapterCache()
	lib.InvalidateFacets()
	return &RescanResult{ChapterCount: chapterCount, PageCount: pageCount, Updated: true}, nil
}

// RescanResult 单部重扫结果。
type RescanResult struct {
	ChapterCount int  `json:"chapterCount"`
	PageCount    int  `json:"pageCount"`
	Updated      bool `json:"updated"`
}

func countPages(c Candidate) int {
	src, err := sources.OpenSource(c.Path, extOfCandidate(c), sources.OpenSourceOptions{})
	if err != nil {
		return 0
	}
	if pages, err := src.ListPages(); err == nil {
		return len(pages)
	}
	return 0
}

func readMetadataOf(c Candidate) *sources.SourceMetadata {
	src, err := sources.OpenSource(c.Path, extOfCandidate(c), sources.OpenSourceOptions{})
	if err != nil {
		return nil
	}
	if m, err := src.ReadMetadata(); err == nil {
		return m
	}
	return nil
}

var errNotFound = &notFoundErr{}

type notFoundErr struct{}

func (notFoundErr) Error() string { return "not found" }
