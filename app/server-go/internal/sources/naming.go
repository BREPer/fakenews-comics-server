// 命名解析：从文件名/目录名提取可读标题。
// 命名解析（正则）。
package sources

import (
	"regexp"
	"strconv"
	"strings"
)

var stripPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(digital|scan|hd| completed|official)\b`),
	regexp.MustCompile(`\((?:\d{4})?\)`),  // 年份括号
	regexp.MustCompile(`\[[^\]]{1,30}\]`), // [发布组]
	regexp.MustCompile(`\{\w+\}`),         // {刮削标记}
}

var extRe = regexp.MustCompile(`(?i)\.(cbz|cbr|cb7|zip|rar|7z|tar|pdf|epub|mobi)$`)

var volumeHint = regexp.MustCompile(`(?i)(?:第\s*([0-9零一二三四五六七八九十百]+)\s*[卷册篇])|(?:v(?:ol)?\.?\s*(\d+))`)

var cnNum = map[rune]int{
	'零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
	'六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}

func cnToInt(s string) (int, bool) {
	if regexp.MustCompile(`^\d+$`).MatchString(s) {
		n := 0
		for _, c := range s {
			n = n*10 + int(c-'0')
		}
		return n, true
	}
	runes := []rune(s)
	if len(runes) == 1 && runes[0] == '十' {
		return 10, true
	}
	if len(runes) >= 2 && runes[1] == '十' {
		tens := 1
		if v, ok := cnNum[runes[0]]; ok && runes[0] != '零' {
			tens = v
		}
		ones := 0
		if len(runes) > 2 {
			if v, ok := cnNum[runes[2]]; ok {
				ones = v
			}
		}
		return tens*10 + ones, true
	}
	if len(runes) == 1 {
		if v, ok := cnNum[runes[0]]; ok {
			return v, true
		}
	}
	return 0, false
}

// ParsedName 解析结果。
type ParsedName struct {
	Title  string
	Volume int // 卷号（0 = 无）
}

// ParseName 提取可读标题（去扩展名/发布组/刮削标记/多余空白）。
func ParseName(raw string) ParsedName {
	s := extRe.ReplaceAllString(raw, "")
	vol := ExtractVolume(s)
	for _, p := range stripPatterns {
		s = p.ReplaceAllString(s, " ")
	}
	s = strings.ReplaceAll(s, "_", " ")
	s = multiSpace.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	s = strings.Trim(s, " \t\r\n-—–:：")
	title := s
	if title == "" {
		title = raw
	}
	return ParsedName{Title: title, Volume: vol}
}

var multiSpace = regexp.MustCompile(`\s{2,}`)

// ExtractVolume 卷号提示（第N卷 / vN）。
func ExtractVolume(s string) int {
	m := volumeHint.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	if m[1] != "" {
		if n, ok := cnToInt(m[1]); ok {
			return n
		}
		return 0
	}
	n := 0
	if v, err := strconv.Atoi(m[2]); err == nil {
		n = v
	}
	return n
}

// GuessAuthor 从路径猜作者：`书名 (作者)` 尾部括号。
func GuessAuthor(rawTitle string) string {
	m := regexp.MustCompile(`[(（]([^)）]{1,40})[)）]\s*$`).FindStringSubmatch(rawTitle)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}
