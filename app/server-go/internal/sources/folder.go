// folder 源：散图文件夹，SectionReader 原生 Range。
// topOnly：只列顶层图片（混合结构漫画的散图章）。
// 散图文件夹源。
package sources

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// SkipDirName 目录遍历的隐藏/NAS 元数据跳过规则（与 walker.ts 一致）。
func SkipDirName(name string) bool {
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "@") ||
		(strings.HasPrefix(name, "#") && strings.HasSuffix(name, "#")) || name == "__MACOSX"
}

func skipDir(name string) bool { return SkipDirName(name) }

// ListFolderImages 递归列出目录下全部图片（跳过隐藏项，含子目录）。
func ListFolderImages(dir string) []string {
	var out []string
	stack := []string{dir}
	for len(stack) > 0 {
		d := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			full := filepath.Join(d, e.Name())
			if e.IsDir() {
				stack = append(stack, full)
			} else if IsImageName(e.Name()) {
				out = append(out, full)
			}
		}
	}
	return out
}

// ListTopImages 只列目录顶层图片（不递归）——混合结构的散图章用。
func ListTopImages(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if (e.Type()&os.ModeSymlink) != 0 || e.Type().IsRegular() {
			if !strings.HasPrefix(e.Name(), ".") && IsImageName(e.Name()) && !SampleFileRe.MatchString(e.Name()) {
				out = append(out, filepath.Join(dir, e.Name()))
			}
		}
	}
	return out
}

// SubDirsOf 直接子目录名（跳过隐藏/NAS 元数据目录）。
func SubDirsOf(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !skipDir(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// FolderSource 散图文件夹源。
type FolderSource struct {
	root    string
	topOnly bool
	// files 同样是懒加载缓存，源实例共享 → 需要锁
	filesMu sync.Mutex
	files   []string
}

// OpenFolder 打开 folder 源；目录不存在返回错误。
func OpenFolder(root string, opts OpenSourceOptions) (*FolderSource, error) {
	st, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, &notDirError{root}
	}
	return &FolderSource{root: root, topOnly: opts.TopOnly}, nil
}

// Format 源格式。
func (f *FolderSource) Format() string { return "folder" }

// ListPages 页清单（自然排序；topOnly 只取顶层）。
func (f *FolderSource) ListPages() ([]PageEntry, error) {
	f.filesMu.Lock()
	files := f.files
	f.filesMu.Unlock()
	if files == nil {
		var raw []string
		if f.topOnly {
			raw = ListTopImages(f.root)
		} else {
			raw = ListFolderImages(f.root)
		}
		files = NaturalSort(raw, func(s string) string { return s })
		f.filesMu.Lock()
		f.files = files
		f.filesMu.Unlock()
	}
	out := make([]PageEntry, len(files))
	for i, file := range files {
		out[i] = PageEntry{Index: i, Name: filepath.Base(file), Path: file, Size: safeSize(file)}
	}
	return out, nil
}

// ListChapters 文件夹的章在文件系统层由 scanner 处理，源内部恒为空。
func (f *FolderSource) ListChapters() ([]SourceChapter, error) { return nil, nil }

// ReadMetadata 目录下 ComicInfo.xml（大小写不敏感）。
func (f *FolderSource) ReadMetadata() (*SourceMetadata, error) {
	entries, err := os.ReadDir(f.root)
	if err != nil {
		return nil, nil
	}
	for _, e := range entries {
		if strings.EqualFold(e.Name(), "comicinfo.xml") {
			b, err := os.ReadFile(filepath.Join(f.root, e.Name()))
			if err != nil {
				return nil, nil
			}
			return ParseComicInfo(string(b)), nil
		}
	}
	return nil, nil
}

// GetPageStream fs SectionReader 原生 Range。
func (f *FolderSource) GetPageStream(index int, opts PageStreamOptions) (*PageStream, error) {
	pages, err := f.ListPages()
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(pages) {
		return nil, ErrPageOutOfRange
	}
	entry := pages[index]
	total := entry.Size
	start := opts.Start
	if start < 0 {
		start = 0
	}
	if start > total {
		start = total
	}
	length := opts.Length
	if length <= 0 || start+length > total {
		length = total - start
	}
	fh, err := os.Open(entry.Path)
	if err != nil {
		return nil, err
	}
	// SectionReader 超出文件末尾自动截断。句柄交回调用方 Close：
	// 不显式关就只能等 GC 回收，翻页多了会 fd 耗尽。
	return &PageStream{
		Stream: io.LimitReader(io.NewSectionReader(fh, start, length), length),
		Size:   length,
		Mime:   MimeOf(entry.Path),
		Closer: fh,
	}, nil
}

// Close 无底层资源。
func (f *FolderSource) Close() {}

type notDirError struct{ path string }

func (e *notDirError) Error() string { return "not a directory: " + e.path }

func safeSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}
