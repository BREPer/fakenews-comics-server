// ComicInfo.xml 解析（通用漫画元数据文件，标签大小写不敏感）。
// 结构扁平，按标签抓取 + 实体解码即可，不做 DTD/命名空间处理。
// ComicInfo.xml 元数据解析。
package sources

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	reCData    = regexp.MustCompile(`(?s)<!\[CDATA\[(.*?)\]\]>`)
	reEntity   = regexp.MustCompile(`&(lt|gt|quot|apos);`)
	reDecEnt   = regexp.MustCompile(`&#(\d+);`)
	reHexEnt   = regexp.MustCompile(`(?i)&#x([0-9a-f]+);`)
	reAmp      = regexp.MustCompile(`&amp;`)
	reInnerTag = regexp.MustCompile(`<[^>]+>`)
	reListSep  = regexp.MustCompile(`[,;，；]`)
)

var xmlEntities = map[string]string{"lt": "<", "gt": ">", "quot": "\"", "apos": "'"}

func decodeEntities(s string) string {
	s = reCData.ReplaceAllString(s, "$1")
	s = reEntity.ReplaceAllStringFunc(s, func(m string) string {
		name := m[1 : len(m)-1]
		return xmlEntities[name]
	})
	s = reDecEnt.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.Atoi(m[2 : len(m)-1])
		return string(rune(n))
	})
	s = reHexEnt.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseInt(m[3:len(m)-1], 16, 32)
		return string(rune(n))
	})
	return reAmp.ReplaceAllString(s, "&") // 最后解，避免二次解码
}

// XMLTag 抓取指定标签文本（去内嵌标签 + 解实体）；ComicInfo 与 EPUB OPF 共用。
func XMLTag(xml, name string) string {
	m := regexp.MustCompile(`(?i)<` + regexp.QuoteMeta(name) + `>([\s\S]*?)</` + regexp.QuoteMeta(name) + `>`).FindStringSubmatch(xml)
	if m == nil {
		return ""
	}
	v := strings.TrimSpace(reInnerTag.ReplaceAllString(decodeEntities(m[1]), ""))
	return v
}

// SplitList 逗号/分号分隔列表拆分（中英文标点）。
func SplitList(v string) []string {
	if v == "" {
		return nil
	}
	parts := reListSep.Split(v, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if len(p) > 0 && len(p) <= 40 {
			out = append(out, p)
		}
		if len(out) >= 30 {
			break
		}
	}
	return out
}

// ParseComicInfo 解析 ComicInfo.xml → 源元数据；无有效字段返回 nil。
func ParseComicInfo(xml string) *SourceMetadata {
	if xml == "" || len(xml) > 512*1024 {
		return nil
	}
	series := XMLTag(xml, "Series")
	titleRaw := XMLTag(xml, "Title")
	number := XMLTag(xml, "Number")

	var title string
	if series != "" && titleRaw != "" {
		if strings.Contains(titleRaw, series) {
			title = titleRaw
		} else {
			title = series + " - " + titleRaw
		}
	} else if titleRaw != "" {
		title = titleRaw
	} else {
		title = series
	}

	meta := &SourceMetadata{
		Title:   title,
		Series:  series,
		Number:  number,
		Author:  XMLTag(xml, "Writer"),
		Summary: XMLTag(xml, "Summary"),
		Genre:   SplitList(XMLTag(xml, "Genre")),
		Tags:    SplitList(XMLTag(xml, "Tags")),
		Year:    XMLTag(xml, "Year"),
	}
	if !meta.HasAny() {
		return nil
	}
	return meta
}
