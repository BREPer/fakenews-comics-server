package routes

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

/* ----------------  fixtures ---------------- */

type zEntry struct {
	name    string
	data    []byte
	dir     bool
	symlink string
}

func makeZip(t *testing.T, p string, entries []zEntry) {
	t.Helper()
	buf := &bytes.Buffer{}
	zw := zip.NewWriter(buf)
	for _, e := range entries {
		name := e.name
		if e.dir && !strings.HasSuffix(name, "/") {
			name += "/"
		}
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		switch {
		case e.dir:
			h.SetMode(os.ModeDir | 0o755)
		case e.symlink != "":
			h.SetMode(os.ModeSymlink | 0o777)
		default:
			h.SetMode(0o644)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if !e.dir {
			content := e.data
			if e.symlink != "" {
				content = []byte(e.symlink)
			}
			if _, err := w.Write(content); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

type tEntry struct {
	name    string
	data    []byte
	dir     bool
	symlink string
}

func makeTar(t *testing.T, p string, entries []tEntry) {
	t.Helper()
	buf := &bytes.Buffer{}
	tw := tar.NewWriter(buf)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(e.data))}
		switch {
		case e.dir:
			h.Typeflag, h.Size, h.Mode = tar.TypeDir, 0, 0o755
		case e.symlink != "":
			h.Typeflag, h.Size, h.Linkname = tar.TypeSymlink, 0, e.symlink
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg && len(e.data) > 0 {
			if _, err := tw.Write(e.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// listRel 列出目录内全部条目（相对路径，统一用 / 分隔，排序）。
func listRel(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dir {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

func has(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

/* ---------------- 最小 RAR3（store 模式）生成器 ----------------
   与 internal/sources/rar_test.go 同源（沙箱无 rar CLI，按 rardecode 解析器逆推）。
   要点：头部 CRC32 覆盖 LONG_BLOCK 的 4 字节 pack size；文件数据 CRC32 小端。 */

const (
	rarMarker = "Rar!\x1a\x07\x00"
	rarBlkArc = 0x73
	rarBlkEnd = 0x7b
	rarBlkFil = 0x74
	rarLong   = 0x8000
	rarSolid  = 0x0010
	rarArcNew = 0x0010
)

func rarHeader(htype byte, flags uint16, data []byte, dataSize uint32) []byte {
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

func writeRar3(t *testing.T, path string, files [][2]string, solid bool) {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString(rarMarker)
	buf.Write(rarHeader(rarBlkArc, rarArcNew, make([]byte, 6), 0))
	for _, kv := range files {
		name, data := kv[0], []byte(kv[1])
		flags := uint16(rarLong)
		if solid {
			flags |= rarSolid
		}
		fh := make([]byte, 0, 21+len(name))
		fh = binary.LittleEndian.AppendUint32(fh, uint32(len(data)))
		fh = append(fh, 0)
		fh = binary.LittleEndian.AppendUint32(fh, crc32.ChecksumIEEE(data))
		fh = binary.LittleEndian.AppendUint32(fh, 0x58210000)
		fh = append(fh, 29)
		fh = append(fh, 0x30)
		fh = binary.LittleEndian.AppendUint16(fh, uint16(len(name)))
		fh = binary.LittleEndian.AppendUint32(fh, 0x20)
		fh = append(fh, name...)
		buf.Write(rarHeader(rarBlkFil, flags, fh, uint32(len(data))))
		buf.Write(data)
	}
	buf.Write(rarHeader(rarBlkEnd, 0, nil, 0))
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

/* ---------------- zip 解压 ---------------- */

func TestExtractZipFlat(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "海贼王.cbz")
	makeZip(t, arc, []zEntry{
		{name: "001.png", data: []byte("p1")},
		{name: "002.png", data: []byte("p2")},
		{name: "ComicInfo.xml", data: []byte("<ComicInfo/>")},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, bytesN, err := extractArchiveToFolder(arc, root, "海贼王", "cbz")
	if err != nil {
		t.Fatal(err)
	}
	if files != 3 || bytesN != int64(len("p1")+len("p2")+len("<ComicInfo/>")) {
		t.Fatalf("files=%d bytes=%d", files, bytesN)
	}
	target := filepath.Join(root, "海贼王")
	for _, want := range []string{"001.png", "002.png", "ComicInfo.xml"} {
		if !has(listRel(t, target), want) {
			t.Fatalf("缺少 %s，实得 %v", want, listRel(t, target))
		}
	}
	// 压缩包本体不保留在库内
	if has(listRel(t, root), "海贼王.cbz") {
		t.Fatal("压缩包不应残留在库根")
	}
}

func TestExtractZipChaptersLiftSingleRootDir(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "OnePiece.cbz")
	makeZip(t, arc, []zEntry{
		{name: "OnePiece", dir: true},
		{name: "OnePiece/vol01/001.png", data: []byte("p1")},
		{name: "OnePiece/vol02/001.png", data: []byte("p2")},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, _, err := extractArchiveToFolder(arc, root, "OnePiece", "cbz")
	if err != nil {
		t.Fatal(err)
	}
	if files != 2 {
		t.Fatalf("files=%d", files)
	}
	got := listRel(t, filepath.Join(root, "OnePiece"))
	want := []string{"vol01", "vol01/001.png", "vol02", "vol02/001.png"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("单根目录未上提，实得 %v", got)
	}
}

func TestExtractZipSkipsHiddenAndSamples(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "x.cbz")
	makeZip(t, arc, []zEntry{
		{name: ".hidden/secret.png", data: []byte("x")},
		{name: "__MACOSX/._x.png", data: []byte("x")},
		{name: "@eaDir/x.png", data: []byte("x")},
		{name: "vol01/sample.png", data: []byte("x")},
		{name: "vol01/preview.png", data: []byte("x")},
		{name: "vol01/001.png", data: []byte("ok")},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, _, err := extractArchiveToFolder(arc, root, "x", "cbz")
	if err != nil {
		t.Fatal(err)
	}
	if files != 1 {
		t.Fatalf("files=%d，应只保留 vol01/001.png", files)
	}
	// 其余条目全部被跳过，临时目录只剩 vol01 一个根 → 触发单根目录上提
	if got := listRel(t, filepath.Join(root, "x")); strings.Join(got, "|") != "001.png" {
		t.Fatalf("实得 %v", got)
	}
}

func TestExtractZipSkipsSymlink(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "x.cbz")
	makeZip(t, arc, []zEntry{
		{name: "vol01/001.png", data: []byte("ok")},
		{name: "vol01/link.png", symlink: "../../etc/passwd"},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, _, err := extractArchiveToFolder(arc, root, "x", "cbz")
	if err != nil {
		t.Fatal(err)
	}
	if files != 1 || has(listRel(t, filepath.Join(root, "x")), "vol01/link.png") {
		t.Fatalf("软链应被跳过，files=%d list=%v", files, listRel(t, filepath.Join(root, "x")))
	}
}

func TestExtractZipSlipContained(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "x.cbz")
	makeZip(t, arc, []zEntry{
		{name: "../evil.png", data: []byte("x")},
		{name: "/abs/evil2.png", data: []byte("x")},
		{name: "vol01/001.png", data: []byte("ok")},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := extractArchiveToFolder(arc, root, "x", "cbz"); err != nil {
		t.Fatal(err)
	}
	// 绝对路径条目被改写成库内相对路径（contained），穿越条目直接丢弃
	if has(listRel(t, filepath.Join(root, "x")), "../evil.png") {
		t.Fatal("穿越条目不应落盘")
	}
	if _, err := os.Stat(filepath.Join(dir, "evil.png")); err == nil {
		t.Fatal("穿越条目写到了库外")
	}
}

func TestExtractZipEmptyArchiveErrors(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "empty.cbz")
	makeZip(t, arc, []zEntry{{name: "vol01", dir: true}})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := extractArchiveToFolder(arc, root, "empty", "cbz"); err == nil {
		t.Fatal("空包应报错")
	}
	if _, err := os.Stat(filepath.Join(root, "empty")); err == nil {
		t.Fatal("失败不应留下文件夹")
	}
}

func TestExtractZipBadArchiveErrors(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "bad.cbz")
	if err := os.WriteFile(arc, []byte("not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := extractArchiveToFolder(arc, root, "bad", "cbz"); err == nil {
		t.Fatal("坏包应报错")
	}
}

func TestExtractArchiveReplacesExistingFolder(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	target := filepath.Join(root, "海贼王")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "stale.png"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	arc := filepath.Join(dir, "海贼王.cbz")
	makeZip(t, arc, []zEntry{{name: "001.png", data: []byte("new")}})
	if _, _, err := extractArchiveToFolder(arc, root, "海贼王", "cbz"); err != nil {
		t.Fatal(err)
	}
	if has(listRel(t, target), "stale.png") {
		t.Fatal("旧文件应被替换清除")
	}
	if !has(listRel(t, target), "001.png") {
		t.Fatal("新文件应就位")
	}
	for _, e := range listRel(t, root) {
		if strings.HasPrefix(e, ".fnold-") {
			t.Fatalf("备份目录应被清理，实得 %v", listRel(t, root))
		}
	}
}

/* ---------------- tar 解压 ---------------- */

func TestExtractTarFlat(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "x.tar")
	makeTar(t, arc, []tEntry{
		{name: "vol01/", dir: true},
		{name: "vol01/001.png", data: []byte("p1")},
		{name: "vol01/link.png", symlink: "/etc/passwd"},
		{name: "vol02/002.png", data: []byte("p2")},
	})
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, _, err := extractArchiveToFolder(arc, root, "x", "tar")
	if err != nil {
		t.Fatal(err)
	}
	if files != 2 {
		t.Fatalf("files=%d，软链应被跳过", files)
	}
	if has(listRel(t, filepath.Join(root, "x")), "vol01/link.png") {
		t.Fatal("软链不应落盘")
	}
}

/* ---------------- rar 解压 ---------------- */

func TestExtractRarWithSkippedEntryDrain(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "x.rar")
	// sample.png 排最前（sorted），会被跳过但必须 drain，否则固实包后续条目丢字典
	writeRar3(t, arc, [][2]string{
		{"sample.png", "SAMPLE"},
		{"vol01/001.png", "PAGE-ONE"},
		{"vol01/002.png", "PAGE-TWO"},
	}, true)
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	files, _, err := extractArchiveToFolder(arc, root, "x", "rar")
	if err != nil {
		t.Fatal(err)
	}
	if files != 2 {
		t.Fatalf("files=%d，样张应被跳过", files)
	}
	// sample.png 被跳过，只剩 vol01 一个根 → 上提
	got, err := os.ReadFile(filepath.Join(root, "x", "001.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "PAGE-ONE" {
		t.Fatalf("drain 失败导致内容损坏: %q", got)
	}
}

/* ---------------- 单元：净化与跳过规则 ---------------- */

func TestComicFolderName(t *testing.T) {
	cases := map[string]string{
		"海贼王.cbz":         "海贼王",
		"a/b.cbz":          "a_b",
		"..hidden.cbz":     "hidden",
		".cbz":             "未命名漫画",
		"trail. .cbz":      "trail",
		"a:b?c*.cbz":       "a_b_c_",
		"  spaced.cbz":     "spaced",
		strings.Repeat("很长", 60) + ".cbz": strings.Repeat("很长", 40),
	}
	for in, want := range cases {
		if got := comicFolderName(in); got != want {
			t.Errorf("comicFolderName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSkipExtractEntry(t *testing.T) {
	skip := []string{".hidden/x.png", "__MACOSX/._x", "@eaDir/x.png", "vol01/sample.png", "vol01/preview.png", "vol01/001_sample.png", "vol01/x.sample.png"}
	keep := []string{"vol01/001.png", "vol01/ComicInfo.xml", "第01卷/001.jpg", "vol01/vol02.cbz", "vol01/thumbs.db"}
	for _, s := range skip {
		if !skipExtractEntry(s) {
			t.Errorf("%q 应被跳过", s)
		}
	}
	for _, s := range keep {
		if skipExtractEntry(s) {
			t.Errorf("%q 不应被跳过", s)
		}
	}
}

func TestSafeEntryRel(t *testing.T) {
	ok := map[string]string{
		"vol01/001.png": "vol01/001.png",
		"./x.png":       "x.png",
		"/etc/passwd":   "etc/passwd",
		"a\\b.png":      "a/b.png",
	}
	for in, want := range ok {
		got, valid := safeEntryRel(in)
		if !valid || filepath.ToSlash(got) != want {
			t.Errorf("safeEntryRel(%q) = %q,%v want %q", in, got, valid, want)
		}
	}
	for _, bad := range []string{"../evil.png", "a/../../b.png", "..", ""} {
		if _, valid := safeEntryRel(bad); valid {
			t.Errorf("safeEntryRel(%q) 应拒绝", bad)
		}
	}
}

func TestLiftSingleRootDir(t *testing.T) {
	// 单个子目录 → 上提
	d1 := t.TempDir()
	inner := filepath.Join(d1, "inner")
	if err := os.MkdirAll(filepath.Join(inner, "vol01"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inner, "vol01", "001.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !liftSingleRootDir(d1) {
		t.Fatal("应上提")
	}
	if !has(listRel(t, d1), "vol01/001.png") {
		t.Fatalf("上提结果不对: %v", listRel(t, d1))
	}
	// 多个条目 / 单文件 → 不动
	d2 := t.TempDir()
	for _, n := range []string{"a", "b"} {
		if err := os.MkdirAll(filepath.Join(d2, n), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if liftSingleRootDir(d2) {
		t.Fatal("多条目不应上提")
	}
	d3 := t.TempDir()
	if err := os.WriteFile(filepath.Join(d3, "001.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if liftSingleRootDir(d3) {
		t.Fatal("单文件不应上提")
	}
}
