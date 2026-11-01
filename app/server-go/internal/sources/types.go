// Package sources 漫画源抽象：统一「列出页 / 读页流 / 元数据 / 内部分章」接口。
// 新增格式只需实现 ComicSource 并在 index.go 注册（O(1) 扩展）。
// 源抽象的公共字段。
package sources

import (
	"io"
	"regexp"
	"strings"
)

// PageEntry 页清单条目。
type PageEntry struct {
	Index int
	Name  string // 展示名（zip 内条目/文件的 basename）
	Path  string // 读取用完整键（zip 内路径 / 文件绝对路径）
	Size  int64
}

// Quality 画质：standard 走缩略图缓存；original 直读源。
type Quality string

const (
	QualityStandard Quality = "standard"
	QualityOriginal Quality = "original"
)

// PageStreamOptions 取页选项。
type PageStreamOptions struct {
	Quality Quality
	Start   int64 // Range 起点（字节，0 起）
	Length  int64 // Range 长度（字节）；<=0 = 到末尾
	// TargetWidth 期望输出像素宽（PDF 按需光栅化用；不给则按源自身最大缩放渲染）
	TargetWidth int
}

// PageStream 页流。
type PageStream struct {
	Stream io.Reader
	Size   int64 // 本次响应体字节数
	Mime   string
	// Closer 非 nil 时必须由调用方在读完后 Close。
	// 仅有的场景是散图文件夹：每次取页 os.Open 一个句柄，不关就等 GC ——
	// 翻几百页后 fd 耗尽（EMFILE），NAS 上表现为整站 500。
	// zip/rar/tar 走内存或 archive 内部读，不需要单独关，保持 nil。
	Closer io.Closer
}

// SourceChapter 源内部分章（zip 系：包内一级目录 = 章）。
type SourceChapter struct {
	ID        string
	Title     string
	PageCount int
}

// SourceMetadata 源内元数据（ComicInfo.xml / EPUB OPF）。
type SourceMetadata struct {
	Title   string
	Series  string
	Number  string
	Author  string
	Summary string
	Genre   []string
	Tags    []string
	Year    string
}

// HasAny 是否有任一非空字段。
func (m *SourceMetadata) HasAny() bool {
	if m == nil {
		return false
	}
	return m.Title != "" || m.Series != "" || m.Number != "" || m.Author != "" ||
		m.Summary != "" || m.Year != "" || len(m.Genre) > 0 || len(m.Tags) > 0
}

// OpenSourceOptions 打开源时的定位选项（把源限定到某一章的视图）。
type OpenSourceOptions struct {
	Prefix  string // zip 型：包内章目录名
	TopOnly bool   // folder 型：只列顶层图片（混合结构的散图章）
}

// ComicSource 漫画源接口。
type ComicSource interface {
	Format() string
	ListPages() ([]PageEntry, error)
	ListChapters() ([]SourceChapter, error)
	ReadMetadata() (*SourceMetadata, error)
	GetPageStream(index int, opts PageStreamOptions) (*PageStream, error)
	Close()
}

// SampleFileRe 样张/推广文件（发布组塞在目录里的预览图）。
var SampleFileRe = regexp.MustCompile(`(?i)(^sample|^preview|^thumbnail|_sample|\.sample)`)

var mimeByExt = map[string]string{
	"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
	"webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp", "avif": "image/avif",
}

// ExtOf 小写扩展名（不含点）。
func ExtOf(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i < 0 {
		return ""
	}
	return strings.ToLower(name[i+1:])
}

// IsImageName 是否图片条目名（zip 内过滤 ComicInfo.xml 等杂项用）。
func IsImageName(name string) bool {
	_, ok := mimeByExt[ExtOf(name)]
	return ok
}

// MimeOf 扩展名 → MIME。
func MimeOf(name string) string {
	if m, ok := mimeByExt[ExtOf(name)]; ok {
		return m
	}
	return "application/octet-stream"
}
