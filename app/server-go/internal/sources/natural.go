// 自然排序：第2章 < 第10章、v2 < v10、01 < 1。
// 章节顺序错误是漫画库第一大投诉源（方案 §6 约束 4）。
// 自然排序；文本段比较用 x/text/collate 的中文
// 排序规则（拼音序）。
package sources

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var segRe = regexp.MustCompile(`(\d+)|(\D+)`)

// zhCollatorPool 提供「独占」的 collator。
//
// collate.Collator 内部维护可变的迭代器与比较缓冲（compare 过程中复用同一个），
// **不是并发安全的**。以前是包级单例，于是 folder 目录列页排序（读图路径）与
// 列表按标题排序并发跑时，会在 collate 内部 panic：
//   runtime error: index out of range [-1]
// 被 recover 兜住后表现成「某张页图 500」，用户看到图裂；压测 1500 请求 / 并发 32
// 稳定复现。改为从池里借一个独占实例，用完 Reset 再归还。
var zhCollatorPool = sync.Pool{
	New: func() any { return collate.New(language.Chinese) },
}

func borrowCollator() *collate.Collator { return zhCollatorPool.Get().(*collate.Collator) }

// releaseCollator 归还实例。collate.Collator 没有 Reset，其内部迭代器在每次
// Compare 开始时自行初始化，因此直接归还即可（池里只会有固定大小的少量实例）。
func releaseCollator(c *collate.Collator) { zhCollatorPool.Put(c) }

// segment 交替的数字/文本段。
type segment struct {
	num    float64
	text   string
	isNum  bool
}

func segments(s string) []segment {
	var out []segment
	for _, m := range segRe.FindAllStringSubmatch(strings.ToLower(s), -1) {
		if m[1] != "" {
			n, _ := strconv.ParseFloat(m[1], 64)
			out = append(out, segment{num: n, isNum: true})
		} else {
			out = append(out, segment{text: m[2]})
		}
	}
	return out
}

// NaturalCompare 自然序比较（单次比较；内部借一个独占 collator）。
func NaturalCompare(a, b string) int {
	c := borrowCollator()
	defer releaseCollator(c)
	return naturalCompare(c, a, b)
}

// naturalCompare 用调用方给定的 collator 做比较（排序时借一次即可）。
func naturalCompare(col *collate.Collator, a, b string) int {
	sa := segments(a)
	sb := segments(b)
	n := len(sa)
	if len(sb) < n {
		n = len(sb)
	}
	for i := 0; i < n; i++ {
		x, y := sa[i], sb[i]
		if x.isNum && y.isNum {
			if x.num != y.num {
				if x.num < y.num {
					return -1
				}
				return 1
			}
		} else if x.isNum != y.isNum {
			// 数字段排在同位文本段之前（第01卷 vs 番外）
			if x.isNum {
				return -1
			}
			return 1
		} else {
			if c := col.CompareString(x.text, y.text); c != 0 {
				return c
			}
		}
	}
	return len(sa) - len(sb)
}

// NaturalSort 稳定自然排序，返回新切片。
func NaturalSort[T any](arr []T, key func(T) string) []T {
	sorted := make([]T, len(arr))
	copy(sorted, arr)
	// 整个排序只借一次 collator：比较函数会被调用 N log N 次，逐次借还太浪费
	c := borrowCollator()
	defer releaseCollator(c)
	sort.SliceStable(sorted, func(i, j int) bool {
		return naturalCompare(c, key(sorted[i]), key(sorted[j])) < 0
	})
	return sorted
}

// CompareZH 中文拼音序比较（Unicode 排序规则，不带数字自然序）。
// 列表页按标题排序用（SQLite 无 ICU，只取 id/title 两列进程内排）。
func CompareZH(a, b string) int {
	c := borrowCollator()
	defer releaseCollator(c)
	return c.CompareString(a, b)
}
