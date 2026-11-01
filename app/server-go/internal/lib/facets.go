// 首页筛选 chips 的聚合结果缓存。
// facets 需要扫全表并逐行解析 tags JSON，是首页每次进入都会打的接口。
// 聚合结果只在「扫描完成 / 改标签 / 删库删书」时才会变，因此整块缓存、由写路径显式失效，
// 不做 TTL（TTL 会让用户改完标签后仍看到旧 chips）。
// facets 聚合结果缓存。
package lib

import (
	"encoding/json"
	"sort"
	"sync"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/sources"
)

// Facet 单个筛选项。
type Facet struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// FacetsData 聚合结果。
type FacetsData struct {
	Formats []Facet `json:"formats"`
	Tags    []Facet `json:"tags"`
}

var (
	facetsMu   sync.Mutex
	facetsKey  string
	facetsData *FacetsData
)

// InvalidateFacets 失效（comics 表 format/tags 有任何变动后调用）。
func InvalidateFacets() {
	facetsMu.Lock()
	defer facetsMu.Unlock()
	facetsData = nil
}

// GetFacets 聚合（带缓存）。
func GetFacets(e env.Env) *FacetsData {
	facetsMu.Lock()
	defer facetsMu.Unlock()
	if facetsData != nil && facetsKey == e.DBFile {
		return facetsData
	}
	rows, err := db.Get(e).Prepare("SELECT format, tags FROM comics").All()
	if err != nil {
		return &FacetsData{}
	}
	formats := map[string]int{}
	tags := map[string]int{}
	for _, r := range rows {
		formats[db.AsString(r, "format")]++
		var list []string
		if err := json.Unmarshal([]byte(db.AsString(r, "tags")), &list); err != nil {
			continue // 脏数据忽略，不影响其它条目
		}
		for _, t := range list {
			if t != "" {
				tags[t]++
			}
		}
	}
	data := &FacetsData{
		Formats: toFacetList(formats),
		Tags:    toFacetList(tags),
	}
	facetsKey = e.DBFile
	facetsData = data
	return data
}

// toFacetList 计数降序 + 中文名称升序（输出稳定，前端 chips 不跳动）。
func toFacetList(m map[string]int) []Facet {
	out := make([]Facet, 0, len(m))
	for v, c := range m {
		out = append(out, Facet{Value: v, Count: c})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return sources.NaturalCompare(out[i].Value, out[j].Value) < 0
	})
	return out
}
