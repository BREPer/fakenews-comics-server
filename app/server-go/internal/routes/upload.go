// upload 路由：把漫画上传进库（按库类型分流，2026-10-23 起）。
//
//   - 章节型（chapter）：仅接受可解压压缩包（zip/cbz/tar/cbt/rar/cbr）。
//     上传后创建以压缩包名称命名的文件夹，自动解压进去（见 upload_extract.go）。
//     压缩包本身不保留。
//   - 单篇型（single）：压缩包 + epub/pdf 原样落盘，不解压。
//
// 公共部分：
//   - multipart，可一次携带多个文件
//   - 写入库的第一个可写根目录，全程路径穿越防护；写完自动触发该库扫描入库
package routes

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/scanner"
)

const maxUploadFileBytes = 2 * 1024 * 1024 * 1024

func registerUpload(mux *http.ServeMux, e env.Env) {
	mux.HandleFunc("POST /api/libraries/{id}/upload", adapt(func(w http.ResponseWriter, r *http.Request) error {
		libID := r.PathValue("id")
		row, _ := db.Get(e).Prepare("SELECT id, type, paths FROM libraries WHERE id = ?").Get(libID)
		if row == nil {
			return lib.NotFound("library not found")
		}
		isChapter := db.AsString(row, "type") == "chapter"
		var roots []string
		_ = json.Unmarshal([]byte(db.AsString(row, "paths")), &roots)

		// 选第一个「存在且可写」的根目录；NAS 上某个卷未挂载时就顺延到下一个
		var root string
		for _, cand := range roots {
			if err := os.MkdirAll(cand, 0o755); err != nil {
				continue
			}
			probe := filepath.Join(cand, ".fakenews-write-probe-"+randHex(8))
			if f, err := os.Create(probe); err == nil {
				_ = f.Close()
				_ = os.Remove(probe)
				root = cand
				break
			}
		}
		if root == "" {
			// 403 而不是 400：这不是请求本身有问题，是服务端环境限制。
			// 典型场景：容器里 COMIC_ROOT 以 `:ro` 挂载（compose 默认如此），
			// 上传必然写不进去。给出可执行的提示，而不是让用户对着 400 猜。
			return lib.Errorf(http.StatusForbidden, 5000,
				"library is read-only (container mounts the comic root read-only): %s",
				strings.Join(roots, ", "))
		}

		ct := r.Header.Get("content-type")
		if !strings.HasPrefix(ct, "multipart/form-data") {
			return lib.BadRequest("multipart required")
		}
		_, params, err := mime.ParseMediaType(ct)
		if err != nil {
			return lib.BadRequest("invalid multipart")
		}
		boundary, ok := params["boundary"]
		if !ok {
			return lib.BadRequest("missing multipart boundary")
		}
		mr := multipart.NewReader(r.Body, boundary)

		written, writtenBytes := 0, int64(0)
		var skipped []string
		var folders []string

		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return lib.BadRequest("invalid multipart body")
			}
			if part.FileName() == "" {
				continue // 字段型 part 跳过
			}
			fileName := part.FileName()
			// 新版上传入口只发单层文件名（压缩包 / epub / pdf）；带目录层级的一律跳过，
			// 避免散图写进库根触发「库根整册漫画」防御（见下方单篇型分支注释）。
			segs, ok := safeSegments(fileName)
			if !ok || len(segs) != 1 {
				skipped = append(skipped, fileName)
				continue
			}
			name := segs[0]
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))

			if isChapter {
				// 章节型：仅可解压压缩包 → 建文件夹解压入库
				if !extractableExt[ext] {
					skipped = append(skipped, name+"（章节型仅支持压缩包：.cbz/.zip/.tar/.cbt/.rar/.cbr）")
					continue
				}
				// 先落到库根的点号临时文件（扫描器跳过点号项），解压完成即删
				spool := filepath.Join(root, ".fnupload-"+randHex(8))
				if _, err := spoolPart(part, spool); err != nil {
					_ = os.Remove(spool)
					return err
				}
				folder := comicFolderName(name)
				files, bytes, xerr := extractArchiveToFolder(spool, root, folder, ext)
				_ = os.Remove(spool)
				if xerr != nil {
					skipped = append(skipped, fmt.Sprintf("%s（%v）", name, xerr))
					continue
				}
				written += files
				writtenBytes += bytes
				folders = append(folders, folder)
				continue
			}

			// 单篇型：压缩包 / epub / pdf 原样落盘
			if !singleUploadExt[ext] {
				skipped = append(skipped, name)
				continue
			}
			// 防御：松散图片（无目录层级）直接落到库根，会被扫描器当成「库根整册漫画」，
			// 进而清空其下所有漫画条目。单篇型也不再接受图片上传（请打包后上传）。
			dest := filepath.Join(root, name)
			tmp := dest + ".fnupload-" + randHex(8)
			size, err := spoolPart(part, tmp)
			if err != nil {
				_ = os.Remove(tmp)
				return err
			}
			if err := os.Rename(tmp, dest); err != nil { // 原子替换，避免半截文件被扫描误读
				_ = os.Remove(tmp)
				return err
			}
			written++
			writtenBytes += size
		}

		// 写完即触发该库扫描，让新书进入书架（与 NAS 同步行为一致）
		scanner.TriggerScan(e, scanner.ScanOptions{LibraryID: libID})
		if skipped == nil {
			skipped = []string{}
		}
		if folders == nil {
			folders = []string{}
		}
		httputil.WriteData(w, map[string]any{
			"written": written, "bytes": writtenBytes, "skipped": skipped,
			"libraryId": libID, "scanning": true, "folders": folders,
		})
		return nil
	}))
}

// spoolPart 把 multipart part 写入临时文件（上限 maxUploadFileBytes），返回字节数。
func spoolPart(part *multipart.Part, dest string) (int64, error) {
	f, err := os.Create(dest)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, io.LimitReader(part, maxUploadFileBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(dest)
		return n, err
	}
	if n > maxUploadFileBytes {
		_ = os.Remove(dest)
		return n, fmt.Errorf("文件超过 %d GB 上限", maxUploadFileBytes/(1024*1024*1024))
	}
	return n, nil
}

// safeSegments 把（可能含子目录的）相对文件名安全化。拒绝任何穿越片段。
func safeSegments(rel string) ([]string, bool) {
	var out []string
	for _, raw := range strings.FieldsFunc(rel, func(r rune) bool { return r == '\\' || r == '/' }) {
		s := strings.TrimSpace(raw)
		if s == "" || s == "." {
			continue
		}
		if s == ".." {
			return nil, false
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
