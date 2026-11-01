// 请求读取 helpers：查询参数、宽容 JSON body。
package httputil

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
)

// Query 查询参数（无则空串）。
func Query(r *http.Request, key string) string {
	return r.URL.Query().Get(key)
}

// QueryInt clampInt 版查询参数（宽容：非数字回落默认）。
func QueryInt(r *http.Request, key string, dflt, min, max int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return dflt
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return dflt
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// DecodeJSON 宽容 JSON 解析：空 body 视作 {}（浏览器/fnOS WebView 的 DELETE 常带空 body）。
func DecodeJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		return err
	}
	if len(trimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

func trimSpace(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && isSpace(b[i]) {
		i++
	}
	for j > i && isSpace(b[j-1]) {
		j--
	}
	return b[i:j]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}
