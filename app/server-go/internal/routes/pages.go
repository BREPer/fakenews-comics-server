// pages 路由：章节页元信息 + 单页图片流（Range）。
// 阅读器高频读接口，走 images/stream.go。
// pages 路由（章内页元信息 / 单页图流）。
package routes

import (
	"net/http"
	"strconv"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/images"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/sources"
)

func registerPages(mux *http.ServeMux, e env.Env) {
	// GET /api/comics/{comicId}/chapters/{chapterId}/pages —— 页元信息
	mux.HandleFunc("GET /api/comics/{comicId}/chapters/{chapterId}/pages", adapt(func(w http.ResponseWriter, r *http.Request) error {
		metas, err := images.ListPageMeta(e, r.PathValue("comicId"), r.PathValue("chapterId"))
		if err != nil {
			return err
		}
		httputil.WriteData(w, map[string]any{"pages": metas})
		return nil
	}))

	// GET /api/comics/{comicId}/chapters/{chapterId}/pages/{index} —— 单页图流
	// ?quality=standard → 缩略图（JPEG，宽 w 默认 800）；original → 原图（支持 Range）
	mux.HandleFunc("GET /api/comics/{comicId}/chapters/{chapterId}/pages/{index}", adapt(func(w http.ResponseWriter, r *http.Request) error {
		index, err := strconv.Atoi(r.PathValue("index"))
		if err != nil || index < 0 {
			return lib.BadRequest("index must be a non-negative integer")
		}
		quality := r.URL.Query().Get("quality")
		if quality == "" {
			quality = "original"
		}

		if quality == "standard" {
			width := httputil.QueryInt(r, "w", 800, 64, 1600)
			out, err := images.GetThumb(e, r.PathValue("comicId"), r.PathValue("chapterId"), index, width)
			if err != nil {
				return err
			}
			w.Header().Set("content-type", out.ContentType)
			w.Header().Set("cache-control", "public, max-age=86400")
			w.Write(out.Buffer)
			return nil
		}

		res, err := images.GetPageStream(e, r.PathValue("comicId"), r.PathValue("chapterId"), index, r.Header.Get("range"))
		if err != nil {
			return err
		}
		// 散图文件夹每页一个 os.Open 句柄，必须释放（漏了会 EMFILE）
		if res.Closer != nil {
			defer func() { _ = res.Closer.Close() }()
		}
		code := 200
		if res.Partial {
			code = 206
		}
		h := w.Header()
		h.Set("content-type", res.Mime)
		h.Set("content-length", strconv.FormatInt(res.Size, 10))
		h.Set("accept-ranges", "bytes")
		h.Set("cache-control", "public, max-age=3600")
		if res.Partial {
			h.Set("content-range", "bytes "+strconv.FormatInt(res.Start, 10)+"-"+strconv.FormatInt(res.End, 10)+"/"+strconv.FormatInt(res.Total, 10))
		}
		w.WriteHeader(code)
		buf := make([]byte, 64*1024)
		for {
			n, err := res.Stream.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return nil // 客户端断开：静默结束
				}
			}
			if err != nil {
				break
			}
		}
		return nil
	}))
}

var _ = sources.QualityStandard
