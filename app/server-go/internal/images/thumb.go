// 缩略图与封面：读源页 → 缩放 JPEG → 磁盘缓存（thumbs/covers-custom/covers）。
// 原图模式不走这里（见 stream.go）。
// 缩略图输出 JPEG（stdlib）。
package images

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/sources"
)

// thumbStandardQuality 标准画质 JPEG 质量（TS: webp q76）。
const thumbStandardQuality = 76

// CoverQuality 封面 JPEG 质量（TS: webp q85）。上传封面/提页封面也用此值。
const CoverQuality = 85

// coverQuality 封面 JPEG 质量（TS: webp q85）。
const coverQuality = CoverQuality

// coverMaxSourceBytes 自动封面跳过的单页大小上限（>50MB 不拿来做封面）。
const coverMaxSourceBytes = 50 * 1024 * 1024

// GetThumb 取章节单页缩略图（width 像素宽）。
func GetThumb(e env.Env, comicID, chapterID string, pageIndex, width int) (*ThumbResult, error) {
	dir := filepath.Join(e.CacheDir, "thumbs", comicID, chapterID)
	file := filepath.Join(dir, fmt.Sprintf("%d_%d.jpg", pageIndex, width))
	if buf, ok := MemGet(file); ok {
		return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
	}
	if buf, err := os.ReadFile(file); err == nil {
		MemSet(file, buf)
		return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
	}
	// miss：并发同一张（预加载 + 当前页）只渲染一次
	return WithInFlight(file, func() (*ThumbResult, error) {
		if buf, ok := MemGet(file); ok {
			return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
		}
		if buf, err := os.ReadFile(file); err == nil {
			MemSet(file, buf)
			return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
		}
		loc, err := ResolveChapter(e, comicID, chapterID)
		if err != nil {
			return nil, err
		}
		if loc == nil {
			return nil, lib.NotFound("comic/chapter not found")
		}
		// 注意：不调用 src.Close()——openSource 返回的是进程内共享缓存实例，
		// 关闭它会让并发/后续请求的同一个源立刻失效（zip 句柄已关）。
		// 源生命周期由 sources 包的 TTL/上限淘汰管理。
		src, err := sources.OpenSource(loc.ChapterPath, loc.Format, SourceOptionsOf(loc))
		if err != nil {
			return nil, err
		}
		pages, err := src.ListPages()
		if err != nil {
			return nil, err
		}
		if pageIndex < 0 || pageIndex >= len(pages) {
			return nil, sources.ErrPageOutOfRange
		}
		raw, err := readPageBytes(src, pageIndex, width)
		if err != nil {
			return nil, err
		}
		out, err := MakeThumb(raw, width, thumbStandardQuality)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(file, out.Buffer, 0o644); err != nil {
			return nil, err
		}
		MemSet(file, out.Buffer)
		NoteCacheWrite(e, int64(len(out.Buffer)))
		return out, nil
	})
}

// CustomCoverMasterPath 自定义封面母图路径。
// 放在 DataDir 而不是 CacheDir：缓存目录会被「清理缓存」整目录删除，
// 用户自己设的封面不能跟着丢。
func CustomCoverMasterPath(e env.Env, comicID string) string {
	return filepath.Join(e.DataDir, "covers", comicID+".img")
}

// CustomCoverDerivedDir 自定义封面的按宽派生缓存（可随时重建）。
func CustomCoverDerivedDir(e env.Env, comicID string) string {
	return filepath.Join(e.CacheDir, "covers-custom", comicID)
}

// ResetCustomCoverCache 丢弃派生缓存：更新封面后必须调用，否则旧宽度的派生图会继续命中。
func ResetCustomCoverCache(e env.Env, comicID string) {
	_ = os.RemoveAll(CustomCoverDerivedDir(e, comicID))
}

// MigrateCustomCovers 把旧版落在 CacheDir/covers-custom 的封面母图搬到 DataDir。
// 旧实现把母图和派生图放同一目录，清缓存时用户封面会被一起删掉。
// 返回迁移条数（幂等：指向 DataDir 的记录会被跳过）。
func MigrateCustomCovers(e env.Env) int {
	rows, err := db.Get(e).Prepare("SELECT id, cover_path FROM comics WHERE cover_path IS NOT NULL AND cover_path <> ''").All()
	if err != nil {
		return 0
	}
	oldRoot := filepath.Join(e.CacheDir, "covers-custom")
	moved := 0
	for _, row := range rows {
		id := db.AsString(row, "id")
		old := db.AsString(row, "cover_path")
		rel, err := filepath.Rel(oldRoot, old)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		b, err := os.ReadFile(old)
		if err != nil {
			continue
		}
		master := CustomCoverMasterPath(e, id)
		if err := os.MkdirAll(filepath.Dir(master), 0o755); err != nil {
			continue
		}
		if err := os.WriteFile(master, b, 0o644); err != nil {
			continue
		}
		if _, err := db.Get(e).Prepare("UPDATE comics SET cover_path = ? WHERE id = ?").Run(master, id); err != nil {
			continue
		}
		ResetCustomCoverCache(e, id)
		moved++
	}
	return moved
}

// GetCover 封面：自定义封面（cover_path）优先，否则章 0 页 0 起回退找第一张读得到的页。
func GetCover(e env.Env, comicID string, width int) (*ThumbResult, error) {
	row := GetComicRow(e, comicID)
	if row == nil {
		return nil, lib.NotFound("comic not found")
	}

	// 1) 自定义封面（长按设封面 / 上传封面写入 cover_path）
	coverPath := db.AsString(row, "cover_path")
	if coverPath != "" {
		if st, err := os.Stat(coverPath); err == nil && !st.IsDir() {
			cdir := CustomCoverDerivedDir(e, comicID)
			cfile := filepath.Join(cdir, fmt.Sprintf("%d.jpg", width))
			if buf, err := os.ReadFile(cfile); err == nil {
				return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
			}
			raw, err := os.ReadFile(coverPath)
			if err == nil {
				out, err := MakeThumb(raw, width, coverQuality)
				if err == nil {
					_ = os.MkdirAll(cdir, 0o755)
					_ = os.WriteFile(cfile, out.Buffer, 0o644)
					NoteCacheWrite(e, int64(len(out.Buffer)))
					return out, nil
				}
			}
			// 自定义封面损坏：回落自动封面
		}
	}

	// 2) 自动封面：从第 1 章起找「第一张真正读得到的页」
	dir := filepath.Join(e.CacheDir, "covers", comicID)
	file := filepath.Join(dir, fmt.Sprintf("%d.jpg", width))
	if buf, err := os.ReadFile(file); err == nil {
		return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
	}
	return WithInFlight(file, func() (*ThumbResult, error) {
		if buf, err := os.ReadFile(file); err == nil {
			return &ThumbResult{Buffer: buf, ContentType: "image/jpeg"}, nil
		}
		// 显式指定章时只试那一章；否则按章序回退（上限 20 章）
		ids := make([]string, 0, 20)
		for i := 0; i < 20; i++ {
			ids = append(ids, fmt.Sprintf("%s#%d", comicID, i))
		}
		var firstErr error
		for _, cid := range ids {
			loc, err := ResolveChapter(e, comicID, cid)
			if err != nil {
				break // 章节列表都读不出来，继续试也没意义
			}
			if loc == nil {
				break // 章不存在 → 已到末尾
			}
			src, err := sources.OpenSource(loc.ChapterPath, loc.Format, SourceOptionsOf(loc))
			if err != nil {
				firstErr = err
				continue // 坏包 → 下一章
			}
			pages, err := src.ListPages()
			if err != nil || len(pages) == 0 {
				continue // 空章 → 下一章
			}
			if pages[0].Size > coverMaxSourceBytes {
				continue // 单页过大 → 下一章
			}
			raw, err := readPageBytes(src, 0, width)
			if err != nil {
				firstErr = err
				continue
			}
			out, err := MakeThumb(raw, width, coverQuality)
			if err != nil {
				firstErr = err
				continue
			}
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(file, out.Buffer, 0o644)
			NoteCacheWrite(e, int64(len(out.Buffer)))
			return out, nil
		}
		if firstErr != nil {
			return nil, firstErr
		}
		return nil, lib.NotFound("no pages")
	})
}

// readPageBytes 读整页字节（缩略图/封面路径；PDF 传 targetWidth 按需渲染）。
func readPageBytes(src sources.ComicSource, index, targetWidth int) ([]byte, error) {
	ps, err := src.GetPageStream(index, sources.PageStreamOptions{
		Quality: sources.QualityOriginal, TargetWidth: targetWidth,
	})
	if err != nil {
		return nil, err
	}
	// 散图文件夹每页一个 os.Open 句柄（PageStream.Closer 契约见 sources/types.go）：
	// 缩略图/封面也是读页，不关就会在批量生成时把 fd 攒到 GC 才回收。
	if ps.Closer != nil {
		defer func() { _ = ps.Closer.Close() }()
	}
	return io.ReadAll(ps.Stream)
}
