// zip/cbz/epub 源：archive/zip 流式随机读，不全量解压上盘。
// 包内分章：一级目录 = 章（海贼王/第01卷/001.jpg → 章「第01卷」）；
// 顶层平铺图片（无目录前缀）视为整包一章。Range：SectionReader skip+limit。
// EPUB：页面顺序由 OPF spine 决定（见 parseEpub）。
// zip / cbz / epub 源。
package sources

import (
	"archive/zip"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// ZipSource zip 系源（zip/cbz/epub 同构）。
type ZipSource struct {
	format  string
	zip     *zip.ReadCloser
	prefix  string
	order   []string // EPUB：spine 决定的条目顺序
	meta    *SourceMetadata
	// pageMap 是 prefix → 页清单的缓存。源实例被 sourceCache 共享给多个 handler，
	// 首页封面 + 阅读器预加载会并发读同一本 —— 必须加锁，否则是 concurrent map writes
	// （不可 recover，直接崩进程）。
	pageMu  sync.Mutex
	pageMap map[string][]PageEntry
}

// OpenZip 打开 zip 系源。
func OpenZip(p, format string, opts OpenSourceOptions) (*ZipSource, error) {
	zr, err := zip.OpenReader(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &notFoundError{p}
		}
		return nil, err
	}
	z := &ZipSource{
		format: format,
		zip:    zr,
		prefix: opts.Prefix,
		pageMap: map[string][]PageEntry{},
	}
	if format == "epub" {
		if parsed := parseEpub(zr); parsed != nil {
			z.order = parsed.spine
			z.meta = parsed.metadata
		}
	}
	return z, nil
}

// Format 源格式。
func (z *ZipSource) Format() string { return z.format }

// imageEntryNames 包内全部图片条目键（过滤目录与杂项）。
func (z *ZipSource) imageEntryNames() []string {
	var out []string
	for _, f := range z.zip.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if IsImageName(f.Name) {
			out = append(out, f.Name)
		}
	}
	return out
}

// entryByName 按条目键取 *zip.File。
func (z *ZipSource) entryByName(name string) *zip.File {
	for _, f := range z.zip.File {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// ListPages 页清单（自然排序；prefix 视图只列该目录下；EPUB 按 spine 序）。
func (z *ZipSource) ListPages() ([]PageEntry, error) {
	key := z.prefix
	z.pageMu.Lock()
	if cached, ok := z.pageMap[key]; ok {
		z.pageMu.Unlock()
		return cached, nil
	}
	z.pageMu.Unlock()
	names := z.imageEntryNames()
	if z.prefix != "" {
		pref := z.prefix + "/"
		var filtered []string
		for _, n := range names {
			if strings.HasPrefix(n, pref) {
				filtered = append(filtered, n)
			}
		}
		names = filtered
	}
	var sorted []string
	if z.order != nil && z.prefix == "" {
		// EPUB：spine 顺序为准，spine 之外的图片按自然排序追加（避免漏页）
		inSpine := map[string]bool{}
		var spine []string
		for _, n := range z.order {
			if z.entryByName(n) != nil && IsImageName(n) && !inSpine[n] {
				inSpine[n] = true
				spine = append(spine, n)
			}
		}
		var rest []string
		for _, n := range names {
			if !inSpine[n] {
				rest = append(rest, n)
			}
		}
		rest = NaturalSort(rest, func(s string) string { return s })
		sorted = append(spine, rest...)
	} else {
		sorted = NaturalSort(names, func(s string) string { return s })
	}
	pages := make([]PageEntry, len(sorted))
	for i, name := range sorted {
		f := z.entryByName(name)
		var size int64
		if f != nil {
			size = int64(f.UncompressedSize64)
		}
		pages[i] = PageEntry{
			Index: i,
			Name:  path.Base(name),
			Path:  name,
			Size:  size,
		}
	}
	// 锁内不做重活：上面构建过程在锁外完成，这里只写一行。
	// 并发时可能重复构建同一个 key，结果一致，可以接受。
	z.pageMu.Lock()
	z.pageMap[key] = pages
	z.pageMu.Unlock()
	return pages, nil
}

// ListChapters 包内一级目录 = 章（仅在无 prefix 的整包视图调用；epub 恒空）。
func (z *ZipSource) ListChapters() ([]SourceChapter, error) {
	if z.prefix != "" {
		return nil, nil
	}
	if z.format == "epub" {
		return nil, nil
	}
	groups := map[string]int{}
	topLevel := 0
	for _, n := range z.imageEntryNames() {
		i := strings.IndexByte(n, '/')
		if i > 0 {
			groups[n[:i]]++
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

// ReadMetadata ComicInfo.xml（优先根级，其次最浅层级）或 EPUB OPF 元数据。
func (z *ZipSource) ReadMetadata() (*SourceMetadata, error) {
	if z.meta != nil {
		return z.meta, nil
	}
	var candidates []string
	for _, f := range z.zip.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if reComicInfo.MatchString(strings.ToLower(f.Name)) {
			candidates = append(candidates, f.Name)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		di := strings.Count(candidates[i], "/")
		dj := strings.Count(candidates[j], "/")
		return di < dj
	})
	pick := candidates[0]
	rc, err := z.zip.Open(pick)
	if err != nil {
		return nil, nil
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, 64*1024))
	if err != nil {
		return nil, nil
	}
	return ParseComicInfo(string(b)), nil
}

var reComicInfo = regexp.MustCompile(`(^|/)comicinfo\.xml$`)

// GetPageStream 包内条目流 + Range（SectionReader skip/limit）。
func (z *ZipSource) GetPageStream(index int, opts PageStreamOptions) (*PageStream, error) {
	pages, err := z.ListPages()
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(pages) {
		return nil, ErrPageOutOfRange
	}
	entry := pages[index]
	total := entry.Size
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
	rc, err := z.zip.Open(entry.Path)
	if err != nil {
		return nil, err
	}
	return &PageStream{
		Stream: skipLimit(rc, start, length),
		Size:   length,
		Mime:   MimeOf(entry.Path),
	}, nil
}

// Close 关闭 zip 读取器。
func (z *ZipSource) Close() { _ = z.zip.Close() }

/* ---------------- Range 跳过（流式） ---------------- */

// skipLimit 从条目流跳过 skip 字节后截取 length 字节。
// zip 解压流不支持 ReaderAt，用 skipLimit 语义：
// 同步 discard 到起点后再 LimitReader（中间 Range 需先解压前面字节，本来就是 O(n)）。
func skipLimit(r io.Reader, skip, length int64) io.Reader {
	if skip > 0 {
		_, _ = io.CopyN(io.Discard, r, skip)
	}
	if length > 0 {
		return io.LimitReader(r, length)
	}
	return r
}

/* ---------------- EPUB 解析 ---------------- */

type epubResult struct {
	spine    []string
	metadata *SourceMetadata
}

// readZipText 读条目文本（小文件）。
func readZipText(zr *zip.ReadCloser, name string) string {
	rc, err := zr.Open(name)
	if err != nil {
		return ""
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, 256*1024))
	if err != nil {
		return ""
	}
	return string(b)
}

// findEntryKey 大小写无关地找真实条目键。
func findEntryKey(zr *zip.ReadCloser, wanted string) string {
	for _, f := range zr.File {
		if f.Name == wanted {
			return wanted
		}
	}
	lower := strings.ToLower(wanted)
	for _, f := range zr.File {
		if strings.ToLower(f.Name) == lower {
			return f.Name
		}
	}
	return ""
}

var (
	reRootfile = regexp.MustCompile(`(?i)<rootfile[^>]*full-path\s*=\s*"([^"]+)"`)
	reManifest = regexp.MustCompile(`(?is)<manifest\b.*?</manifest>`)
	reSpine    = regexp.MustCompile(`(?is)<spine\b.*?</spine>`)
	reItem     = regexp.MustCompile(`(?is)<item\b[^>]*/?>`)
	reItemref  = regexp.MustCompile(`(?is)<itemref\b[^>]*/?>`)
	reAttr     = regexp.MustCompile(`(?i)\b(\w[\w-]*)\s*=\s*"([^"]*)"`)
)

// xmlAttr 从标签文本取属性值。
func xmlAttr(tagText, name string) string {
	for _, m := range reAttr.FindAllStringSubmatch(tagText, -1) {
		if strings.EqualFold(m[1], name) {
			return decodePercent(m[2])
		}
	}
	return ""
}

func decodePercent(s string) string {
	// 简化 percent 解码（href 常见 %20 等）
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if n, err := parseHexByte(s[i+1 : i+3]); err == nil {
				b.WriteByte(n)
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func parseHexByte(s string) (byte, error) {
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		default:
			return 0, &hexErr{}
		}
		n = n*16 + d
	}
	return byte(n), nil
}

type hexErr struct{}

func (hexErr) Error() string { return "bad hex" }

// parseEpub container.xml → OPF → manifest/spine。
func parseEpub(zr *zip.ReadCloser) *epubResult {
	containerKey := findEntryKey(zr, "META-INF/container.xml")
	if containerKey == "" {
		return nil
	}
	m := reRootfile.FindStringSubmatch(readZipText(zr, containerKey))
	if m == nil {
		return nil
	}
	opfPath := decodePercent(m[1])
	opfKey := findEntryKey(zr, opfPath)
	if opfKey == "" {
		return nil
	}
	opf := readZipText(zr, opfKey)
	if opf == "" {
		return nil
	}

	opfDir := path.Dir(opfKey)
	resolve := func(href string) string {
		clean := strings.SplitN(href, "#", 2)[0]
		if opfDir == "." {
			return clean
		}
		return path.Clean(path.Join(opfDir, clean))
	}

	byID := map[string]string{}
	if mb := reManifest.FindString(opf); mb != "" {
		for _, it := range reItem.FindAllString(mb, -1) {
			id := xmlAttr(it, "id")
			href := xmlAttr(it, "href")
			if id != "" && href != "" {
				byID[id] = resolve(href)
			}
		}
	}

	var order []string
	if sb := reSpine.FindString(opf); sb != "" {
		for _, ir := range reItemref.FindAllString(sb, -1) {
			if idref := xmlAttr(ir, "idref"); idref != "" {
				if target, ok := byID[idref]; ok {
					order = append(order, target)
				}
			}
		}
	}

	// 只保留确实存在的图片条目
	var spine []string
	seen := map[string]bool{}
	for _, p := range order {
		k := findEntryKey(zr, p)
		if k != "" && IsImageName(k) && !seen[k] {
			seen[k] = true
			spine = append(spine, k)
		}
	}

	creator := XMLTag(opf, "dc:creator")
	if creator == "" {
		creator = XMLTag(opf, "creator")
	}
	title := XMLTag(opf, "dc:title")
	if title == "" {
		title = XMLTag(opf, "title")
	}
	summary := XMLTag(opf, "dc:description")
	if summary == "" {
		summary = XMLTag(opf, "description")
	}
	subjects := XMLTag(opf, "dc:subject")
	if subjects == "" {
		subjects = XMLTag(opf, "subject")
	}
	var meta *SourceMetadata
	if title != "" || creator != "" || summary != "" || subjects != "" {
		meta = &SourceMetadata{Title: title, Author: creator, Summary: summary, Genre: SplitList(subjects)}
	}
	return &epubResult{spine: spine, metadata: meta}
}
