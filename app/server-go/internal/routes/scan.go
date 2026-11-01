// scan 路由：触发增量扫描 + 状态查询。
// scan 路由（状态 / 触发）。
package routes

import (
	"net/http"

	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/scanner"
)

func registerScan(mux *http.ServeMux, e env.Env) {
	// POST /api/scan —— 触发扫描（默认增量；full=true 强制全量重解析）
	mux.HandleFunc("POST /api/scan", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			LibraryID string `json:"libraryId"`
			Full      bool   `json:"full"`
		}
		_ = httputil.DecodeJSON(r, &body)
		st := scanner.GetScanStatus()
		if st.Running {
			httputil.WriteData(w, map[string]any{"started": false, "status": st})
			return nil
		}
		scanner.TriggerScan(e, scanner.ScanOptions{LibraryID: body.LibraryID, Full: body.Full})
		httputil.WriteData(w, map[string]any{"started": true, "status": scanner.GetScanStatus()})
		return nil
	}))

	// GET /api/scan/status —— { running, total, done, current }
	mux.HandleFunc("GET /api/scan/status", adapt(func(w http.ResponseWriter, r *http.Request) error {
		httputil.WriteData(w, scanner.GetScanStatus())
		return nil
	}))
}
