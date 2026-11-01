// tar/cbt 源：标准库 archive/tar，零第三方依赖。
//
// 与 ZipSource 保持同一套语义（包内一级目录 = 章、prefix 章视图、ComicInfo、
// Range 流），这样上层（扫描器 / 路由 / 前端）完全感知不到格式差异。
//
// 随机访问做法：遍历一遍条目头（tar 只能顺序读头），记下每个图片条目的
// DataOffset + Size，之后用 io.NewSectionReader 直接按字节区间读，
// 不必为翻一页把整个包从头解压一遍。
package sources

import (
	"archive/tar"
	"io"
	"os"
	"path"
	"strings"
	"sync"
)

// countReader 记录已消费的字节数。
// tar.Reader 读条目头是精确 ReadFull、跳过上一个条目的填充也是精确 CopyN，
// 都不存在预读，所以 Next() 返回的那一刻，计数就是当前条目数据的起始偏移。
// archive/tar 没有导出 DataOffset，只能这样拿。
type countReader struct {
	r io.Reader
	n int64
}

func (c *countReader) Read(p []byte) (int, error) {
	m, err := c.r.Read(p)
	c.n += int64(m)
	return m, err
}

// TarSource tar 系源（tar/cbt 同构）。
type TarSource struct {
	format  string
	file    *os.File
	entries []tarEntry
	prefix  string
	comicInfo []byte // 遍历时顺手读出的 ComicInfo.xml（避免二次遍历）
	meta    *SourceMetadata
	// 与 ZipSource 同理：源实例被缓存共享，并发读同一本会 concurrent map writes
	pageMu  sync.Mutex
	pageMap map[string][]PageEntry
}

type tarEntry struct {
	name string
	size int64
	off  int64
}

// OpenTar 打开 tar 系源（遍历一次条目头）。
func OpenTar(p, format string, opts OpenSourceOptions) (*TarSource, error) {
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &notFoundError{p}
		}
		return nil, err
	}
	t := &TarSource{
		format:  format,
		file:    f,
		prefix:  opts.Prefix,
		pageMap: map[string][]PageEntry{},
	}
	cr := &countReader{r: f}
	tr := tar.NewReader(cr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = f.Close()
			return nil, err
		}
		// 此刻 cr.n 正好落在本条目的数据起始处
		off := cr.n
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			continue // 目录 / 符号链接 / PAX 元数据等
		}
		name := strings.TrimPrefix(path.Clean(h.Name), "./")
		if name == "" || name == "." {
			continue
		}
		// ComicInfo 在遍历途中顺手读掉（条目数据正好在手上），省掉第二次遍历
		if len(t.comicInfo) == 0 && h.Size > 0 && h.Size <= 64*1024 && reComicInfo.MatchString(strings.ToLower(name)) {
			if b, err := io.ReadAll(io.LimitReader(tr, 64*1024)); err == nil {
				t.comicInfo = b
			}
			continue
		}
		if !IsImageName(name) {
			continue
		}
		t.entries = append(t.entries, tarEntry{name: name, size: h.Size, off: off})
	}
	return t, nil
}

// Format 源格式。
func (t *TarSource) Format() string { return t.format }

// ListPages 页清单（自然排序；prefix 视图只列该目录下）。
func (t *TarSource) ListPages() ([]PageEntry, error) {
	key := t.prefix
	t.pageMu.Lock()
	if cached, ok := t.pageMap[key]; ok {
		t.pageMu.Unlock()
		return cached, nil
	}
	t.pageMu.Unlock()
	names := make([]string, 0, len(t.entries))
	for _, e := range t.entries {
		names = append(names, e.name)
	}
	if t.prefix != "" {
		pref := t.prefix + "/"
		var filtered []string
		for _, n := range names {
			if strings.HasPrefix(n, pref) {
				filtered = append(filtered, n)
			}
		}
		names = filtered
	}
	sorted := NaturalSort(names, func(s string) string { return s })
	pages := make([]PageEntry, len(sorted))
	for i, name := range sorted {
		var size int64
		for _, e := range t.entries {
			if e.name == name {
				size = e.size
				break
			}
		}
		pages[i] = PageEntry{
			Index: i,
			Name:  path.Base(name),
			Path:  name,
			Size:  size,
		}
	}
	t.pageMu.Lock()
	t.pageMap[key] = pages
	t.pageMu.Unlock()
	return pages, nil
}

// ListChapters 包内一级目录 = 章（与 ZipSource 一致；顶层平铺则整包一章）。
func (t *TarSource) ListChapters() ([]SourceChapter, error) {
	if t.prefix != "" {
		return nil, nil
	}
	groups := map[string]int{}
	topLevel := 0
	for _, e := range t.entries {
		i := strings.IndexByte(e.name, '/')
		if i > 0 {
			groups[e.name[:i]]++
		} else {
			topLevel++
		}
	}
	if len(groups) == 0 || topLevel > 0 {
		return nil, nil
	}
	dirs := make([]string, 0, len(groups))
	for d := range groups {
		dirs = append(dirs, d)
	}
	dirs = NaturalSort(dirs, func(s string) string { return s })
	out := make([]SourceChapter, len(dirs))
	for i, d := range dirs {
		out[i] = SourceChapter{ID: d, Title: ParseName(d).Title, PageCount: groups[d]}
	}
	return out, nil
}

// ReadMetadata ComicInfo.xml（遍历时已读出）。
func (t *TarSource) ReadMetadata() (*SourceMetadata, error) {
	if t.meta != nil {
		return t.meta, nil
	}
	if len(t.comicInfo) == 0 {
		return nil, nil
	}
	return ParseComicInfo(string(t.comicInfo)), nil
}

// GetPageStream 条目按字节区间直读 + Range。
func (t *TarSource) GetPageStream(index int, opts PageStreamOptions) (*PageStream, error) {
	pages, err := t.ListPages()
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(pages) {
		return nil, ErrPageOutOfRange
	}
	entry := pages[index]
	var e tarEntry
	for _, x := range t.entries {
		if x.name == entry.Path {
			e = x
			break
		}
	}
	total := e.size
	if total <= 0 {
		return &PageStream{Stream: strings.NewReader(""), Size: 0, Mime: MimeOf(entry.Path)}, nil
	}
	start := opts.Start
	if start < 0 {
		start = 0
	}
	if start > total-1 {
		start = total - 1
	}
	length := opts.Length
	if length <= 0 || start+length > total {
		length = total - start
	}
	return &PageStream{
		Stream: io.NewSectionReader(t.file, e.off+start, length),
		Size:   length,
		Mime:   MimeOf(entry.Path),
	}, nil
}

// Close 关闭文件句柄。
func (t *TarSource) Close() { _ = t.file.Close() }
