// 上传解压：章节型漫画库「上传整部漫画」的落地逻辑。
//
// 契约（2026-10-23 起，按库类型分流）：
//   - 章节型：仅接受可解压压缩包（zip/cbz/tar/cbt/rar/cbr）。上传后创建以压缩包
//     名称命名的文件夹，把内容解压进去；压缩包本身不保留（避免同一文件夹里
//     「散图 + 压缩包」被扫描器算重章）。
//   - 单篇型：压缩包 + epub/pdf 原样落盘，不解压（见 upload.go）。
//
// 实现要点：
//  1. 先解到库根的点号临时目录（.fnx-*，扫描器跳过点号项），完成后再就位，
//     失败不留半截文件夹；
//  2. 单根目录上提：整个包只打了一个顶层文件夹时（常见的一键打包形态），
//     内容上提一层，避免「漫画名/漫画名/章节」双层嵌套；
//  3. 条目名净化：拒绝 `..` 穿越；隐藏目录 / __MACOSX / 样张按扫描器同规则跳过；
//  4. 上限：单条目 2GB、单包解压总量 8GB（图片再压缩率接近 1:1，超了只能是炸弹）；
//  5. rar 跳过的条目必须 drain：固实归档跳过文件头不解压会丢字典（同 sources/rar.go）。
package routes

import (
	"archive/tar"
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/nwaples/rardecode/v2"

	"fakenews-comics/internal/sources"
)

const (
	// maxExtractEntryBytes 单个条目解压上限（与上传单文件上限一致）。
	maxExtractEntryBytes = 2 * 1024 * 1024 * 1024
	// maxExtractTotalBytes 单个压缩包解压总上限。
	maxExtractTotalBytes = 8 * 1024 * 1024 * 1024
)

// extractableExt 章节型允许上传且服务端能解压的格式。
var extractableExt = map[string]bool{
	"zip": true, "cbz": true, "tar": true, "cbt": true, "rar": true, "cbr": true,
}

// singleUploadExt 单篇型允许上传的格式：压缩包 + epub/pdf（原样落盘）。
var singleUploadExt = map[string]bool{
	"zip": true, "cbz": true, "tar": true, "cbt": true, "rar": true, "cbr": true,
	"7z": true, "cb7": true, "epub": true, "pdf": true,
}

// extractArchiveToFolder 把压缩包解压成 root 下一部漫画文件夹（名为 base）。
// 返回解出的文件数与总字节数。
func extractArchiveToFolder(archivePath, root, base, ext string) (int, int64, error) {
	tmp := filepath.Join(root, ".fnx-"+randHex(8))
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return 0, 0, err
	}
	defer os.RemoveAll(tmp) // 就位/失败后 tmp 均已不存在或需清理，RemoveAll 幂等

	var (
		files int
		total int64
		err   error
	)
	switch ext {
	case "zip", "cbz":
		files, total, err = extractZip(archivePath, tmp)
	case "tar", "cbt":
		files, total, err = extractTar(archivePath, tmp)
	case "rar", "cbr":
		files, total, err = extractRar(archivePath, tmp)
	default:
		return 0, 0, fmt.Errorf("不支持的压缩格式: %s", ext)
	}
	if err != nil {
		return files, total, err
	}
	if files == 0 {
		return 0, 0, fmt.Errorf("压缩包内没有可解压的内容")
	}

	liftSingleRootDir(tmp)

	target := filepath.Join(root, base)
	if _, statErr := os.Stat(target); statErr == nil {
		// 已存在同名漫画（重复上传/更新）：旧目录退到点号备份位，新的就位后再删；
		// 就位失败则回滚，保证旧漫画不丢。
		backup := filepath.Join(root, ".fnold-"+randHex(8))
		if err := os.Rename(target, backup); err != nil {
			return files, total, err
		}
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Rename(backup, target)
			return files, total, err
		}
		_ = os.RemoveAll(backup)
	} else {
		if err := os.Rename(tmp, target); err != nil {
			return files, total, err
		}
	}
	return files, total, nil
}

func extractZip(archivePath, dest string) (int, int64, error) {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return 0, 0, err
	}
	defer zr.Close()
	files, total := 0, int64(0)
	for _, f := range zr.File {
		if f.Mode()&os.ModeSymlink != 0 {
			continue // 软链不落盘
		}
		if f.FileInfo().IsDir() {
			continue // 目录由写入文件时按需创建
		}
		rel, ok := safeEntryRel(f.Name)
		if !ok {
			continue
		}
		if skipExtractEntry(rel) {
			continue
		}
		if f.UncompressedSize64 > maxExtractEntryBytes {
			return files, total, fmt.Errorf("条目过大: %s", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			return files, total, err
		}
		n, err := writeExtractedFile(dest, rel, rc)
		_ = rc.Close()
		if err != nil {
			return files, total, err
		}
		files++
		total += n
		if total > maxExtractTotalBytes {
			return files, total, fmt.Errorf("解压总量超过 %d GB 上限", maxExtractTotalBytes/(1024*1024*1024))
		}
	}
	return files, total, nil
}

func extractTar(archivePath, dest string) (int, int64, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	files, total := 0, int64(0)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return files, total, err
		}
		// 只落普通文件；目录按需创建，软链/硬链/设备等一律跳过
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			continue
		}
		rel, ok := safeEntryRel(h.Name)
		if !ok {
			continue
		}
		if skipExtractEntry(rel) {
			continue
		}
		if h.Size > maxExtractEntryBytes {
			return files, total, fmt.Errorf("条目过大: %s", h.Name)
		}
		n, err := writeExtractedFile(dest, rel, io.LimitReader(tr, h.Size))
		if err != nil {
			return files, total, err
		}
		files++
		total += n
		if total > maxExtractTotalBytes {
			return files, total, fmt.Errorf("解压总量超过 %d GB 上限", maxExtractTotalBytes/(1024*1024*1024))
		}
	}
	return files, total, nil
}

func extractRar(archivePath, dest string) (int, int64, error) {
	rc, err := rardecode.OpenReader(archivePath)
	if err != nil {
		return 0, 0, err
	}
	defer rc.Close()
	files, total := 0, int64(0)
	for {
		h, err := rc.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return files, total, err
		}
		if h.IsDir {
			continue
		}
		rel, ok := safeEntryRel(h.Name)
		if !ok || skipExtractEntry(rel) {
			// 跳过也要真正读一遍：固实归档跳过文件头不解压会丢字典（见 sources/rar.go）
			if _, err := io.Copy(io.Discard, rc); err != nil {
				return files, total, err
			}
			continue
		}
		n, err := writeExtractedFile(dest, rel, io.LimitReader(rc, maxExtractEntryBytes+1))
		if err != nil {
			return files, total, err
		}
		if n > maxExtractEntryBytes {
			return files, total, fmt.Errorf("条目过大: %s", h.Name)
		}
		files++
		total += n
		if total > maxExtractTotalBytes {
			return files, total, fmt.Errorf("解压总量超过 %d GB 上限", maxExtractTotalBytes/(1024*1024*1024))
		}
	}
	return files, total, nil
}

// safeEntryRel 把归档条目名转成目标目录内的安全相对路径。
// 绝对路径/`..` 都会被剥成库内相对形态（穿越即失效），返回 false 表示不可用。
func safeEntryRel(name string) (string, bool) {
	segs, ok := safeSegments(name)
	if !ok || len(segs) == 0 {
		return "", false
	}
	return filepath.Join(segs...), true
}

// skipExtractEntry 解压跳过规则，与扫描器保持一致：隐藏目录/ NAS 元数据 / 样张。
func skipExtractEntry(rel string) bool {
	first, base := rel, rel
	if i := strings.IndexAny(rel, `/\`); i >= 0 {
		first = rel[:i]
	}
	if i := strings.LastIndexAny(rel, `/\`); i >= 0 {
		base = rel[i+1:]
	}
	if sources.SkipDirName(first) {
		return true
	}
	return sources.SampleFileRe.MatchString(base)
}

// writeExtractedFile 把条目流写入 dest/rel：先写临时文件再改名，避免半截文件被扫描误读。
func writeExtractedFile(dest, rel string, r io.Reader) (int64, error) {
	target := filepath.Join(dest, rel)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return 0, err
	}
	tmp := target + ".fntmp-" + randHex(6)
	f, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	n, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return n, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return n, closeErr
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return n, err
	}
	return n, nil
}

// liftSingleRootDir 单根目录上提：整个压缩包只打了一个顶层文件夹时，
// 把文件夹内容上提一层，避免「漫画名/漫画名/章节」双层嵌套。
// 上提失败保持原样（不影响可用性）。
func liftSingleRootDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		return false
	}
	only := entries[0]
	if !only.IsDir() {
		return false
	}
	inner := filepath.Join(dir, only.Name())
	children, err := os.ReadDir(inner)
	if err != nil {
		return false
	}
	for _, c := range children {
		if err := os.Rename(filepath.Join(inner, c.Name()), filepath.Join(dir, c.Name())); err != nil {
			return false
		}
	}
	_ = os.Remove(inner)
	return true
}

// comicFolderName 由压缩文件名生成库内文件夹名：去扩展名、净化非法字符、限长。
// 前导点会被扫描器当隐藏目录，必须去掉；空名回落「未命名漫画」。
func comicFolderName(fileName string) string {
	base := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	var b strings.Builder
	for _, r := range base {
		switch {
		case r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' ||
			r == '"' || r == '<' || r == '>' || r == '|' || r < 0x20:
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	name := strings.Trim(strings.TrimSpace(b.String()), ". ")
	if name == "" {
		return "未命名漫画"
	}
	if runes := []rune(name); len(runes) > 80 {
		name = string(runes[:80])
	}
	return name
}
