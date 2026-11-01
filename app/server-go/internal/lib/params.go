// 参数校验与清洗：needString/needInt/clampInt/sanitizeQuery/escapeLike。
package lib

import (
	"regexp"
	"strconv"
	"strings"
)

var reControlChars = regexp.MustCompile(`[\x00-\x1f\x7f]`)
var reLikeSpecial = regexp.MustCompile(`[\\%_]`)

// NeedString 断言非空字符串字段。
func NeedString(v any, field string, max int) (string, error) {
	s, ok := v.(string)
	if !ok || s == "" {
		return "", BadRequest(field + " required")
	}
	if len(s) > max {
		return "", BadRequest(field + " too long")
	}
	return s, nil
}

// NeedInt 断言整数字段（越界报错）。
func NeedInt(v any, field string, min, max int) (int, error) {
	n, ok := toIntStrict(v)
	if !ok || n < min || n > max {
		return 0, BadRequest(field + " out of range")
	}
	return n, nil
}

// ClampInt 宽容取整并夹紧（UI 参数：非法值回落默认而不是报错）。
func ClampInt(v any, dflt, min, max int) int {
	n, ok := toIntLoose(v)
	if !ok {
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

func toIntStrict(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		if t != float64(int64(t)) {
			return 0, false
		}
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func toIntLoose(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case string:
		if t == "" {
			return 0, false
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		return int(n), true
	default:
		return 0, false
	}
}

// SanitizeQuery 清洗搜索词：去控制字符（含 NUL，SQLite 会在 NUL 处截断导致匹配全部）并限长。
func SanitizeQuery(v any, max int) string {
	s, _ := v.(string)
	if s == "" {
		return ""
	}
	s = reControlChars.ReplaceAllString(s, "")
	t := strings.TrimSpace(s)
	if len(t) > max {
		t = t[:max]
	}
	return t
}

// EscapeLike 转义 LIKE 通配符，配合 ESCAPE '\' 使用。
func EscapeLike(s string) string {
	return reLikeSpecial.ReplaceAllStringFunc(s, func(m string) string { return `\` + m })
}
