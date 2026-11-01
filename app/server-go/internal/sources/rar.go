// rar/cbr 源：github.com/nwaples/rardecode/v2（纯 Go，vendor 在 third_party/）。
//
// 与 ZipSource/TarSource 保持同一套语义（包内一级目录 = 章、prefix 章视图、
// ComicInfo、Range 流），上层感知不到格式差异。
//
// 两个与 zip/tar 不同的关键点：
//  1. rardecode 只能顺序读，且一个 Reader 不是并发安全的。所以「页清单」在打开时
//     遍历一次头拿到（不含数据），翻页时**每次请求单独开一个 Reader**，
//     请求之间不共享状态。
//  2. 固实（solid）归档：后面条目的解码依赖前面条目的字典。只跳过文件头是不够的，
//     必须把前面条目真正读一遍（drain），否则输出是乱码。非固实归档（漫画 rar 的
//     常见形态）跳过头即可，接近零成本。
package sources

import (
	"io"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/nwaples/rardecode/v2"
)

// RarSource rar 系源（rar/cbr 同构）。
type RarSource struct {
	format    string
	path      string
	prefix    string
	entries   []rarEntry
	comicInfo []byte
	// 归档里是否存在固实（solid）条目。存在时随机访问必须把跳过的条目真正读一遍，
	// 否则后续条目的解压字典不完整、输出乱码（详见文件头说明）。
	anySolid bool
	meta     *SourceMetadata
	// 与 ZipSource 同理：源实例被缓存共享，并发读同一本会 concurrent map writes
	pageMu  sync.Mutex
	pageMap map[string][]PageEntry
}

type rarEntry struct {
	name string
	size int64
}

// OpenRar 打开 rar 系源（只遍历文件头，不读数据）。
func OpenRar(p, format string, opts OpenSourceOptions) (*RarSource, error) {
	rc, err := rardecode.OpenReader(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &notFoundError{p}
		}
		return nil, err
	}
	defer rc.Close()
	r := &RarSource{
		format:  format,
		path:    p,
		prefix:  opts.Prefix,
		pageMap: map[string][]PageEntry{},
	}
	for {
		h, err := rc.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.IsDir {
			continue
		}
		name := strings.TrimPrefix(path.Clean(h.Name), "./")
		if name == "" || name == "." {
			continue
		}
		if !IsImageName(name) {
			// ComicInfo 顺手读出（此时数据正好在手上），省一次遍历
			if len(r.comicInfo) == 0 && h.UnPackedSize > 0 && h.UnPackedSize <= 64*1024 &&
				reComicInfo.MatchString(strings.ToLower(name)) {
				if b, err := io.ReadAll(io.LimitReader(rc, 64*1024)); err == nil {
					r.comicInfo = b
				}
			}
			continue
		}
		size := h.UnPackedSize
		if h.UnKnownSize || size < 0 {
			size = 0 // 流式归档大小未知：Range 无从谈起，按 0 处理（与 tar/zip 一致）
		}
		if h.Solid {
			r.anySolid = true
		}
		r.entries = append(r.entries, rarEntry{name: name, size: size})
	}
	return r, nil
}

// Format 源格式。
func (r *RarSource) Format() string { return r.format }

// ListPages 页清单（自然排序；prefix 视图只列该目录下）。
func (r *RarSource) ListPages() ([]PageEntry, error) {
	key := r.prefix
	r.pageMu.Lock()
	if cached, ok := r.pageMap[key]; ok {
		r.pageMu.Unlock()
		return cached, nil
	}
	r.pageMu.Unlock()
	names := make([]string, 0, len(r.entries))
	for _, e := range r.entries {
		names = append(names, e.name)
	}
	if r.prefix != "" {
		pref := r.prefix + "/"
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
		for _, e := range r.entries {
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
	r.pageMu.Lock()
	r.pageMap[key] = pages
	r.pageMu.Unlock()
	return pages, nil
}

// ListChapters 包内一级目录 = 章（与 TarSource 一致；顶层平铺则整包一章）。
func (r *RarSource) ListChapters() ([]SourceChapter, error) {
	if r.prefix != "" {
		return nil, nil
	}
	groups := map[string]int{}
	topLevel := 0
	for _, e := range r.entries {
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

// ReadMetadata ComicInfo.xml（打开时已读出）。
func (r *RarSource) ReadMetadata() (*SourceMetadata, error) {
	if r.meta != nil {
		return r.meta, nil
	}
	if len(r.comicInfo) == 0 {
		return nil, nil
	}
	return ParseComicInfo(string(r.comicInfo)), nil
}

// GetPageStream 打开独立 Reader、定位到目标条目后按 Range 流出。
func (r *RarSource) GetPageStream(index int, opts PageStreamOptions) (*PageStream, error) {
	pages, err := r.ListPages()
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(pages) {
		return nil, ErrPageOutOfRange
	}
	entry := pages[index]
	var e rarEntry
	for _, x := range r.entries {
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

	rc, err := rardecode.OpenReader(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &notFoundError{r.path}
		}
		return nil, err
	}
	body, err := r.locateEntry(rc, entry.Path)
	if err != nil {
		_ = rc.Close()
		return nil, err
	}
	// 读完后由调用方 Close；这里包一层，把 rc 的生命周期绑到流上。
	// Closer 必须一起返回：客户端中途断开时路由不会再读到 EOF，
	// 只靠 rarStream 的自动关闭会等到 GC 才释放归档句柄。
	stream := &rarStream{rc: rc, r: skipLimit(body, start, length)}
	return &PageStream{
		Stream: stream,
		Closer: stream,
		Size:   length,
		Mime:   MimeOf(entry.Path),
	}, nil
}

// locateEntry 把 Reader 推进到目标条目，返回其数据流。
// 固实归档必须把跳过的条目真正读一遍（drain）才能保住解压字典；
// 非固实归档跳过头即可，接近零成本。
func (r *RarSource) locateEntry(rc *rardecode.ReadCloser, name string) (io.Reader, error) {
	for {
		h, err := rc.Next()
		if err == io.EOF {
			return nil, &notFoundError{name}
		}
		if err != nil {
			return nil, err
		}
		if h.IsDir {
			continue
		}
		if h.Name == name || strings.TrimPrefix(path.Clean(h.Name), "./") == name {
			return rc, nil
		}
		if r.anySolid {
			if _, err := io.Copy(io.Discard, rc); err != nil {
				return nil, err
			}
		}
	}
}

// rarStream 把 ReadCloser 的生命周期绑到流上。
// 消费方（images/stream、thumb、路由）都是「读到 EOF 就结束」，不会显式 Close，
// 所以在 EOF/出错时自动关掉底层 Reader，避免每次翻页漏一个文件句柄。
type rarStream struct {
	rc   *rardecode.ReadCloser
	r    io.Reader
	once sync.Once
}

func (s *rarStream) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if err != nil {
		s.once.Do(func() { _ = s.rc.Close() })
	}
	return n, err
}

func (s *rarStream) Close() error {
	var err error
	s.once.Do(func() { err = s.rc.Close() })
	return err
}

// Close 源本身不持有句柄（每次翻页独立开关 Reader），无需清理。
func (r *RarSource) Close() {}
