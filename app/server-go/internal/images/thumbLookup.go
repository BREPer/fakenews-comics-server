// comicId/chapterId → 读取定位（thumb / routes / stream 共用）。
// 章定位统一由 scanner.ListChapters 产出，本模块只做 id → 定位的解析。
// 缩略图磁盘查找。
package images

import (
	"regexp"
	"strconv"
	"strings"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/scanner"
	"fakenews-comics/internal/sources"
)

// ComicLocation 章定位。
type ComicLocation struct {
	ComicID      string
	Path         string // 漫画文件/文件夹路径
	Format       string // 'folder' | 'zip' | 'cbz' | ...
	ChapterID    string
	ChapterIndex int
	// 章的读取入口：folder 型 = 章目录；zip 型 = 压缩包文件
	ChapterPath string
	// zip 型：包内章目录名（配合 ChapterPath 定位章内页）
	EntryPrefix string
	// folder 型混合结构：散图章只读顶层图片
	TopOnly bool
}

// GetComicRow 漫画行（含库类型，一次查询拿全）。
func GetComicRow(e env.Env, comicID string) map[string]any {
	row, _ := db.Get(e).Prepare(`
    SELECT c.id, c.title, c.format, c.path, c.library_id, c.cover_path, l.type AS lib_type
    FROM comics c LEFT JOIN libraries l ON l.id = c.library_id
    WHERE c.id = ?`).Get(comicID)
	return row
}

var reChapterIdx = regexp.MustCompile(`^\d+$`)

// ResolveChapter 解析 chapterId（`comicId#index`）→ 章定位；chapterId 缺省为第 0 章。
// 校验归属：前缀必须与该漫画一致、索引须为纯十进制非负整数（不宽容解析）。
func ResolveChapter(e env.Env, comicID, chapterID string) (*ComicLocation, error) {
	row := GetComicRow(e, comicID)
	if row == nil {
		return nil, nil
	}
	idx := 0
	if chapterID != "" {
		sep := strings.IndexByte(chapterID, '#')
		if sep < 0 {
			return nil, nil
		}
		owner := chapterID[:sep]
		idxStr := chapterID[sep+1:]
		if owner != comicID || !reChapterIdx.MatchString(idxStr) {
			return nil, nil
		}
		n, convErr := strconv.Atoi(idxStr)
		if convErr != nil || n < 0 {
			// 超长数字（溢出）也走这里，不能让负索引流到 chapters[idx] 触发 panic
			return nil, nil
		}
		idx = n
	}
	path := db.AsString(row, "path")
	format := db.AsString(row, "format")
	chapters, err := scanner.ListChapters(path, format, comicID, db.AsString(row, "lib_type") == "chapter")
	if err != nil {
		return nil, err
	}
	if idx >= len(chapters) {
		return nil, nil
	}
	ch := chapters[idx]
	loc := &ComicLocation{
		ComicID:      comicID,
		Path:         path,
		Format:       format,
		ChapterID:    ch.ID,
		ChapterIndex: idx,
		ChapterPath:  ch.Path,
		EntryPrefix:  ch.Prefix,
		TopOnly:      ch.TopOnly,
	}
	// 章自身的源格式：文件夹内的 zip/pdf/epub 章节用其扩展名，否则沿用整部漫画格式
	if ch.Format != "" {
		loc.Format = ch.Format
	}
	return loc, nil
}

// SourceOptionsOf 定位 → openSource 选项（各消费方共用，避免各处手拼 prefix/topOnly）。
func SourceOptionsOf(loc *ComicLocation) sources.OpenSourceOptions {
	return sources.OpenSourceOptions{Prefix: loc.EntryPrefix, TopOnly: loc.TopOnly}
}
