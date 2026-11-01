package sources

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

/* ---------------- 最小 RAR3（store 模式）生成器 ----------------

   沙箱里没有任何 rar 命令行工具，模块自带的 zip 里也没有 .rar 夹具，
   所以按 rardecode 自己的解析器（archive15.go）逆推出最小合法归档：
   marker + archive header + file header(LONG_BLOCK, method=0x30 store) + data + end block。
   头部 CRC32 覆盖「从 HEAD_TYPE 到块尾」，文件数据 CRC32 存成小端 4 字节
   （rardecode 用 leHash32 比对，且默认开启校验）。
   能被子贡的 rardecode 正确读出，就说明格式构造与读取两端都对。 */

const (
	rarMarker  = "Rar!\x1a\x07\x00"
	rarBlkArc  = 0x73
	rarBlkFile = 0x74
	rarBlkEnd  = 0x7b
	rarLong    = 0x8000 // LONG_BLOCK：头内有 4 字节 pack size
	rarSolid   = 0x0010
	rarArcNew  = 0x0010 // 新命名规则（卷命名用）
)

func rarHeader(htype byte, flags uint16, data []byte, dataSize uint32) []byte {
	// 头部 CRC32 覆盖「从 HEAD_TYPE 到块尾」——**包含** LONG_BLOCK 的 4 字节 pack size，
	// 漏掉它就是 rardecode: bad header crc。
	var body []byte
	body = append(body, htype)
	body = binary.LittleEndian.AppendUint16(body, flags)
	size := 7 + len(data)
	if flags&rarLong != 0 {
		size += 4
	}
	body = binary.LittleEndian.AppendUint16(body, uint16(size))
	if flags&rarLong != 0 {
		body = binary.LittleEndian.AppendUint32(body, dataSize)
	}
	body = append(body, data...)

	crc := crc32.ChecksumIEEE(body) & 0xFFFF
	out := make([]byte, 0, 2+len(body))
	out = binary.LittleEndian.AppendUint16(out, uint16(crc))
	return append(out, body...)
}

// writeRar3 生成 store 模式的 RAR3 归档；solid=true 时给文件打上固实标记。
func writeRar3(t *testing.T, path string, files map[string][]byte, solid bool) {
	t.Helper()
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var buf bytes.Buffer
	buf.WriteString(rarMarker)

	// archive header：reserved1(2) + reserved2(4)
	buf.Write(rarHeader(rarBlkArc, rarArcNew, make([]byte, 6), 0))

	for _, name := range keys {
		data := files[name]
		flags := uint16(rarLong)
		if solid {
			flags |= rarSolid
		}
		// 文件头数据区（不含 4 字节 pack size）
		fh := make([]byte, 0, 21+len(name))
		fh = binary.LittleEndian.AppendUint32(fh, uint32(len(data))) // UNP_SIZE
		fh = append(fh, 0)                                          // HOST_OS = MS-DOS
		fh = binary.LittleEndian.AppendUint32(fh, crc32.ChecksumIEEE(data)) // FILE_CRC（小端）
		fh = binary.LittleEndian.AppendUint32(fh, 0x58210000)       // FTIME（2024-01-01）
		fh = append(fh, 29)                                         // UNP_VER
		fh = append(fh, 0x30)                                       // METHOD = store
		fh = binary.LittleEndian.AppendUint16(fh, uint16(len(name)))
		fh = binary.LittleEndian.AppendUint32(fh, 0x20) // ATTR
		fh = append(fh, name...)
		buf.Write(rarHeader(rarBlkFile, flags, fh, uint32(len(data))))
		buf.Write(data)
	}

	// end block（size=7，无数据）
	buf.Write(rarHeader(rarBlkEnd, 0, nil, 0))

	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRarSourcePagesAndRange(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fixture.cbr")
	page10 := pngBytes(t, 40, 60, 'A')
	page11 := pngBytes(t, 60, 40, 'B')
	writeRar3(t, p, map[string][]byte{
		"vol01/010.png": page10,
		"vol01/011.png": page11,
		"vol10/100.png": pngBytes(t, 30, 30, 'C'),
	}, false)

	src, err := OpenRar(p, "cbr", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenRar: %v", err)
	}
	defer src.Close()

	if src.Format() != "cbr" {
		t.Fatalf("Format() = %q, want cbr", src.Format())
	}
	pages, err := src.ListPages()
	if err != nil {
		t.Fatalf("ListPages: %v", err)
	}
	if len(pages) != 3 {
		t.Fatalf("页数 = %d, want 3", len(pages))
	}
	wantOrder := []string{"vol01/010.png", "vol01/011.png", "vol10/100.png"}
	for i, w := range wantOrder {
		if pages[i].Path != w {
			t.Fatalf("第 %d 页 = %q, want %q", i, pages[i].Path, w)
		}
	}
	if pages[0].Size != int64(len(page10)) {
		t.Fatalf("首页 size = %d, want %d", pages[0].Size, len(page10))
	}

	// 整读
	st, err := src.GetPageStream(0, PageStreamOptions{})
	if err != nil {
		t.Fatalf("GetPageStream: %v", err)
	}
	all, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(all, page10) {
		t.Fatalf("整读字节不一致（len=%d want=%d）", len(all), len(page10))
	}

	// Range：前 100 字节
	st, err = src.GetPageStream(0, PageStreamOptions{Start: 0, Length: 100})
	if err != nil {
		t.Fatalf("GetPageStream range: %v", err)
	}
	head, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(head, page10[:100]) {
		t.Fatal("Range 前 100 字节不一致")
	}

	// Range：中段
	st, err = src.GetPageStream(0, PageStreamOptions{Start: 5, Length: 15})
	if err != nil {
		t.Fatalf("GetPageStream mid: %v", err)
	}
	mid, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(mid, page10[5:20]) {
		t.Fatalf("Range 中段字节不一致: %x", mid)
	}

	if _, err := src.GetPageStream(3, PageStreamOptions{}); err != ErrPageOutOfRange {
		t.Fatalf("越界应返回 ErrPageOutOfRange, got %v", err)
	}
}

func TestRarSourceChaptersAndPrefix(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fixture.rar")
	writeRar3(t, p, map[string][]byte{
		"vol01/010.png": pngBytes(t, 10, 10, 'A'),
		"vol01/011.png": pngBytes(t, 10, 10, 'B'),
		"vol02/020.png": pngBytes(t, 10, 10, 'C'),
		"vol10/100.png": pngBytes(t, 10, 10, 'D'),
	}, false)

	src, err := OpenRar(p, "rar", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenRar: %v", err)
	}
	defer src.Close()

	chapters, err := src.ListChapters()
	if err != nil {
		t.Fatalf("ListChapters: %v", err)
	}
	if len(chapters) != 3 {
		t.Fatalf("章数 = %d, want 3", len(chapters))
	}
	if chapters[2].ID != "vol10" {
		t.Fatalf("第三章 = %q, want vol10（数值序）", chapters[2].ID)
	}

	view, err := OpenRar(p, "rar", OpenSourceOptions{Prefix: "vol02"})
	if err != nil {
		t.Fatalf("OpenRar prefix: %v", err)
	}
	defer view.Close()
	pages, _ := view.ListPages()
	if len(pages) != 1 || pages[0].Path != "vol02/020.png" {
		t.Fatalf("prefix 视图页清单 = %+v", pages)
	}
	if ch, _ := view.ListChapters(); len(ch) != 0 {
		t.Fatalf("prefix 视图不应再有章: %+v", ch)
	}
}

func TestRarSourceComicInfoAndSolid(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fixture.rar")
	xml := `<ComicInfo><Title>Rar Ben</Title><Writer>Packer</Writer></ComicInfo>`
	writeRar3(t, p, map[string][]byte{
		"ComicInfo.xml": []byte(xml),
		"001.png":       pngBytes(t, 10, 10, 'A'),
		"002.png":       pngBytes(t, 10, 10, 'B'),
		"003.png":       pngBytes(t, 10, 10, 'C'),
	}, true) // 固实归档：随机访问必须 drain 前面的条目

	src, err := OpenRar(p, "rar", OpenSourceOptions{})
	if err != nil {
		t.Fatalf("OpenRar: %v", err)
	}
	defer src.Close()

	pages, _ := src.ListPages()
	if len(pages) != 3 {
		t.Fatalf("页数 = %d, want 3（ComicInfo 不应计入）", len(pages))
	}
	meta, err := src.ReadMetadata()
	if err != nil {
		t.Fatalf("ReadMetadata: %v", err)
	}
	if meta == nil || meta.Title != "Rar Ben" || meta.Author != "Packer" {
		t.Fatalf("元数据 = %+v", meta)
	}
	// 固实归档随机读最后一页：字节必须与源一致
	last := pngBytes(t, 10, 10, 'C')
	st, err := src.GetPageStream(2, PageStreamOptions{})
	if err != nil {
		t.Fatalf("GetPageStream(2): %v", err)
	}
	got, _ := io.ReadAll(st.Stream)
	if !bytes.Equal(got, last) {
		t.Fatalf("固实归档随机读末页字节不一致（len=%d want=%d）", len(got), len(last))
	}
}

func TestOpenSourceRarBadArchive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "bad.rar")
	if err := os.WriteFile(p, []byte("这不是 rar"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := OpenSource(p, "rar", OpenSourceOptions{})
	var se *SourceError
	if err == nil {
		t.Fatal("坏包应报错")
	}
	if !asSourceError(err, &se) || se.Status != 415 {
		t.Fatalf("坏包应映射为 415 SourceError, got %v", err)
	}
}
