// Package lib 错误与响应规范：统一 { code, data } / { code, message } 信封。
// 错误码定义。
package lib

import "fmt"

// APIError 业务错误：HTTP 状态 + 业务码 + 文案。
type APIError struct {
	Status  int
	Code    int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// Errorf 构造业务错误。
func Errorf(status, code int, format string, args ...any) *APIError {
	return &APIError{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// NotFound 404 / 业务码 4040。
func NotFound(msg ...string) *APIError {
	m := "not found"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &APIError{Status: 404, Code: 4040, Message: m}
}

// BadRequest 400 / 业务码 4000。
func BadRequest(msg ...string) *APIError {
	m := "bad request"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &APIError{Status: 400, Code: 4000, Message: m}
}

// BadSource 415 / 业务码 5000（坏包/加密/格式不符）。
func BadSource(format string, args ...any) *APIError {
	return &APIError{Status: 415, Code: 5000, Message: fmt.Sprintf(format, args...)}
}

// NotSupported 415 / 业务码 5000（格式不支持）。
func NotSupported(format string, args ...any) *APIError {
	return &APIError{Status: 415, Code: 5000, Message: fmt.Sprintf(format, args...)}
}

// RangeNotSatisfiable 416 / 业务码 5000（附带 Content-Range，由路由补头）。
type RangeError struct {
	Total int64
}

func (e *RangeError) Error() string { return "range not satisfiable" }
