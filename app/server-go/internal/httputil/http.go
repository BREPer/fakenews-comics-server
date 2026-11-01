// Package httputil JSON 信封与错误响应：{ code, data } / { code, message }。
// 响应规范见方案 §6。
package httputil

import (
	"encoding/json"
	"net/http"
)

// Envelope 统一响应信封。
type Envelope struct {
	Code int    `json:"code"`
	Data any    `json:"data,omitempty"`
	Msg  string `json:"message,omitempty"`
}

// WriteJSON 写任意 JSON。
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteData 成功信封 { code: 0, data }。
func WriteData(w http.ResponseWriter, data any) {
	WriteJSON(w, http.StatusOK, Envelope{Code: 0, Data: data})
}

// WriteError 错误信封 { code, message }。
func WriteError(w http.ResponseWriter, status, code int, msg string) {
	WriteJSON(w, status, Envelope{Code: code, Msg: msg})
}

// Handler 返回 error 的处理器；错误由 adapt 统一转信封。
type Handler func(w http.ResponseWriter, r *http.Request) error
