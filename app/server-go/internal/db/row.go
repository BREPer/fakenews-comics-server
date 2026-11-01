// DB 行读取 helpers：map[string]any → 具体类型（含 []byte→string 归一）。
package db

import "strconv"

// AsString 取字符串列（nil/非字符串回落空串）。
func AsString(row map[string]any, key string) string {
	if row == nil {
		return ""
	}
	if v, ok := row[key].(string); ok {
		return v
	}
	return ""
}

// AsStringPtr 取可空字符串列（nil → nil）。
func AsStringPtr(row map[string]any, key string) *string {
	if row == nil {
		return nil
	}
	switch v := row[key].(type) {
	case string:
		return &v
	case nil:
		return nil
	default:
		s := ""
		if b, ok := row[key].([]byte); ok {
			s = string(b)
		}
		return &s
	}
}

// AsInt64 取整数列（float64/int64/字符串数字均可）。
func AsInt64(row map[string]any, key string) int64 {
	if row == nil {
		return 0
	}
	switch v := row[key].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		return parseInt64(v)
	case []byte:
		return parseInt64(string(v))
	default:
		return 0
	}
}

// AsInt int 版 AsInt64。
func AsInt(row map[string]any, key string) int { return int(AsInt64(row, key)) }

// AsFloat 取浮点列（float64/int64/字符串数字均可）。
// percent 是 REAL 列且带小数（前端按 0.1 精度上报），用 AsInt 读会把 6.7 截成 6。
func AsFloat(row map[string]any, key string) float64 {
	if row == nil {
		return 0
	}
	switch v := row[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case string:
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0
		}
		return f
	case []byte:
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil {
			return 0
		}
		return f
	default:
		return 0
	}
}

func parseInt64(s string) int64 {
	var n int64
	neg := false
	i := 0
	if i < len(s) && (s[i] == '-' || s[i] == '+') {
		neg = s[i] == '-'
		i++
	}
	for ; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	if neg {
		return -n
	}
	return n
}
