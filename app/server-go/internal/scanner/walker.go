// 目录遍历：收集候选漫画（文件或文件夹），跳过隐藏项与样张文件。
// 目录遍历（含 promote 提升规则与根目录不参与 promote）。
package scanner

import (
	"os"
	"path/filepath"

	"fakenews-comics/internal/sources"
)

// COMIC_EXTS 可识别的漫画文件扩展名（含暂不支持解析的格式标记）。
var COMIC_EXTS = map[string]bool{
	"cbz": true, "cbr": true, "cb7": true, "zip": true, "rar": true,
	"7z": true, "tar": true, "cbt": true, "pdf": true, "epub": true, "mobi": true,
}

// CHAPTER_ARCHIVE_EXTS 可作为「文件夹章节」的打包格式（仅有源码支持的）。
var CHAPTER_ARCHIVE_EXTS = map[string]bool{"zip": true, "cbz": true, "tar": true, "cbt": true, "rar": true, "cbr": true, "pdf": true, "epub": true}

// 样张/推广文件（与 sources 包共用同一规则）。
var sampleRe = sources.SampleFileRe

// Candidate 候选漫画。
type Candidate struct {
	Path           string
	Kind           string // "file" | "folder"
	Ext            string // 小写扩展名；folder 型为 ""
	SizeBytes      int64
	FileModifiedAt int64
}

func isImageFile(name string) bool { return sources.IsImageName(name) }

func isComicFile(name string) bool { return COMIC_EXTS[sources.ExtOf(name)] }

// FolderHasImages 目录是否直接含图（≥1 张非样张图）。导出给 routes 的 browse 接口
// 计算 leafHint（库路径点选器提示「这一层本身就是一部漫画」）。
func FolderHasImages(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Type().IsRegular() || e.Type()&os.ModeSymlink != 0 {
			if isImageFile(e.Name()) && !sampleRe.MatchString(e.Name()) {
				return true
			}
		}
	}
	return false
}

// TopArchivesOf 目录顶层可作章节的打包文件（跳过样张与隐藏项）。导出原因同上。
func TopArchivesOf(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if !CHAPTER_ARCHIVE_EXTS[sources.ExtOf(e.Name())] {
			continue
		}
		if sampleRe.MatchString(e.Name()) {
			continue
		}
		if sources.SkipDirName(e.Name()) {
			continue
		}
		out = append(out, e.Name())
	}
	return out
}

// WalkRoot 遍历根目录收集候选漫画。
// promote=true（章节型库）：含图子目录/顶层打包的文件夹提升为整部漫画；
// 根目录本身不参与 promote（根的直接子目录才是漫画）。
func WalkRoot(root string, onCandidate func(Candidate), promote bool) {
	skip := func(name string) bool { return sources.SkipDirName(name) }

	var process func(dir string, isRoot bool)
	process = func(dir string, isRoot bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return // 权限/挂载失效跳过，不让整个扫描失败
		}
		var subdirs []string
		var archives []string
		hasImages := false
		for _, e := range entries {
			if skip(e.Name()) {
				continue
			}
			full := filepath.Join(dir, e.Name())
			switch {
			case e.IsDir():
				subdirs = append(subdirs, e.Name())
			case e.Type().IsRegular() && isComicFile(e.Name()) && !sampleRe.MatchString(e.Name()):
				archives = append(archives, full)
			case (e.Type().IsRegular() || e.Type()&os.ModeSymlink != 0) && isImageFile(e.Name()) && !sampleRe.MatchString(e.Name()):
				hasImages = true
			}
		}

		// 1. 章节型（仅根以下层级）：含图子目录 / 顶层压缩包即整部漫画
		if promote && !isRoot {
			hasImageSubdir := false
			for _, d := range subdirs {
				if FolderHasImages(filepath.Join(dir, d)) {
					hasImageSubdir = true
					break
				}
			}
			if hasImageSubdir || len(TopArchivesOf(dir)) > 0 {
				emit(dir, "folder", "", onCandidate)
				return
			}
		}

		// 2. 单章漫画：本级直接含图（两种类型通用）
		if hasImages {
			emit(dir, "folder", "", onCandidate)
			return
		}

		// 3. 组织目录：发射压缩包，继续下钻
		for _, a := range archives {
			emit(a, "file", sources.ExtOf(a), onCandidate)
		}
		for _, d := range subdirs {
			process(filepath.Join(dir, d), false)
		}
	}
	process(root, true)
}

func emit(p, kind, ext string, onCandidate func(Candidate)) {
	st, err := os.Stat(p)
	if err != nil {
		return
	}
	onCandidate(Candidate{
		Path:           p,
		Kind:           kind,
		Ext:            ext,
		SizeBytes:      st.Size(),
		FileModifiedAt: st.ModTime().UnixMilli(),
	})
}
