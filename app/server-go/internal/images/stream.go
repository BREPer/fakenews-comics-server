// 原图流：Range 响应。
// folder 型 → fs SectionReader（原生 Range）；zip 型 → 源流 skip/limit；
// PDF 型 → 先渲染整页拿真实尺寸，再按 Range 切片。
// standard 画质由 thumb.go 的缩略图缓存承接，不走本模块。
// 流式响应（原图 Range / 缩略图）。
package images

import (
	"io"
	"regexp"
	"strconv"
	"strings"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/sources"
)

// ImageStreamResult 原图流结果。
type ImageStreamResult struct {
	Stream  io.Reader
	Size    int64 // 本次响应体字节数（200 = 整页；206 = 切片长度）
	Total   int64 // 条目总大小（Content-Range 的 total 用）
	Mime    string
	Start   int64
	End     int64 // inclusive
	Partial bool
	// Closer 透传底层源的句柄（散图文件夹才有），handler 读完必须 Close
	Closer io.Closer
}

// RangeResolution Range 解析结果。
type RangeResolution struct {
	Kind             string // none / ok / unsatisfiable
	Start, End       int64
}

// ResolveRange 解析 Range 头（只处理单段 bytes=a-b）。
// none=无/语法非法（按 RFC 忽略，返回整页）；ok=可满足；unsatisfiable=越界（416）。
func ResolveRange(header string, size int64) RangeResolution {
	if header == "" || !strings.HasPrefix(header, "bytes=") {
		return RangeResolution{Kind: "none"}
	}
	m := regexp.MustCompile(`^(\d*)-(\d*)$`).FindStringSubmatch(strings.TrimSpace(header[6:]))
	if m == nil {
		return RangeResolution{Kind: "none"}
	}
	a, b := m[1], m[2]
	if a == "" && b == "" {
		return RangeResolution{Kind: "none"}
	}
	var start, end int64
	if a == "" {
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return RangeResolution{Kind: "none"}
		}
		start = size - n
		if start < 0 {
			start = 0
		}
		end = size - 1
	} else {
		var err error
		start, err = strconv.ParseInt(a, 10, 64)
		if err != nil {
			return RangeResolution{Kind: "none"}
		}
		if b == "" {
			end = size - 1
		} else {
			end, err = strconv.ParseInt(b, 10, 64)
			if err != nil {
				return RangeResolution{Kind: "none"}
			}
		}
	}
	if start >= size {
		return RangeResolution{Kind: "unsatisfiable"}
	}
	if start > end {
		return RangeResolution{Kind: "none"}
	}
	if end > size-1 {
		end = size - 1
	}
	return RangeResolution{Kind: "ok", Start: start, End: end}
}

// GetPageStream 取章节单页原图流（含 Range）。
func GetPageStream(e env.Env, comicID, chapterID string, pageIndex int, rangeHeader string) (*ImageStreamResult, error) {
	loc, err := ResolveChapter(e, comicID, chapterID)
	if err != nil {
		return nil, err
	}
	if loc == nil {
		return nil, lib.NotFound("comic/chapter not found")
	}
	src, err := sources.OpenSource(loc.ChapterPath, loc.Format, SourceOptionsOf(loc))
	if err != nil {
		return nil, err
	}
	pages, err := src.ListPages()
	if err != nil {
		return nil, err
	}
	if pageIndex < 0 || pageIndex >= len(pages) {
		return nil, lib.NotFound("page out of range")
	}
	entry := pages[pageIndex]

	// entry.Size > 0 ⇒ 尺寸已知（zip/folder），直接按 Range 取
	if entry.Size > 0 {
		r := ResolveRange(rangeHeader, entry.Size)
		if r.Kind == "unsatisfiable" {
			return nil, &lib.RangeError{Total: entry.Size}
		}
		partial := r.Kind == "ok"
		start := int64(0)
		length := entry.Size
		if partial {
			start = r.Start
			length = r.End - r.Start + 1
		}
		ps, err := src.GetPageStream(pageIndex, sources.PageStreamOptions{
			Quality: sources.QualityOriginal, Start: start, Length: length,
		})
		if err != nil {
			return nil, err
		}
		size := ps.Size
		if size <= 0 {
			size = length
		}
		return &ImageStreamResult{
			Stream: ps.Stream, Size: size, Total: entry.Size, Mime: ps.Mime, Closer: ps.Closer,
			Start: start, End: start + size - 1, Partial: partial,
		}, nil
	}

	// entry.Size = 0 ⇒ 按需渲染源（PDF）：先取整页拿真实尺寸，再解析 Range
	whole, err := src.GetPageStream(pageIndex, sources.PageStreamOptions{
		Quality: sources.QualityOriginal, Start: 0, Length: 0,
	})
	if err != nil {
		return nil, err
	}
	realSize := whole.Size
	r := ResolveRange(rangeHeader, realSize)
	if r.Kind == "unsatisfiable" {
		return nil, &lib.RangeError{Total: realSize}
	}
	if r.Kind == "none" {
		// 无 Range：直接返回整页流（避免二次渲染）
		return &ImageStreamResult{
			Stream: whole.Stream, Size: realSize, Total: realSize, Mime: whole.Mime,
			Start: 0, End: realSize - 1, Partial: false,
		}, nil
	}
	start := r.Start
	length := r.End - r.Start + 1
	// PDF 按 index LRU 缓存渲染结果，二次取为缓存命中
	ps, err := src.GetPageStream(pageIndex, sources.PageStreamOptions{
		Quality: sources.QualityOriginal, Start: start, Length: length,
	})
	if err != nil {
		return nil, err
	}
	size := ps.Size
	if size <= 0 {
		size = length
	}
	return &ImageStreamResult{
		Stream: ps.Stream, Size: size, Total: realSize, Mime: ps.Mime,
		Start: start, End: start + size - 1, Partial: true,
	}, nil
}

// PageMeta 页元信息。
type PageMeta struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
}

// ListPageMeta 章节页元信息（前端 split 判定与预加载用）。
func ListPageMeta(e env.Env, comicID, chapterID string) ([]PageMeta, error) {
	loc, err := ResolveChapter(e, comicID, chapterID)
	if err != nil {
		return nil, err
	}
	if loc == nil {
		return nil, lib.NotFound("comic/chapter not found")
	}
	src, err := sources.OpenSource(loc.ChapterPath, loc.Format, SourceOptionsOf(loc))
	if err != nil {
		return nil, err
	}
	pages, err := src.ListPages()
	if err != nil {
		return nil, err
	}
	out := make([]PageMeta, len(pages))
	for i, p := range pages {
		out[i] = PageMeta{Index: p.Index, Name: p.Name, Size: p.Size}
	}
	return out, nil
}
