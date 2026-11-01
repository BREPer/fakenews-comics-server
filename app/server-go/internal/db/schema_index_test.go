// 索引回归：列表默认排序必须整段走索引，不能退化成 TEMP B-TREE。
package db

import (
	"path/filepath"
	"strings"
	"testing"

	"fakenews-comics/internal/env"
)

// TestListSortUsesIndex 锁住「列表排序走索引」这件事。
//
// 背景：列表 SQL 是 `ORDER BY c.added_at DESC, c.id`（次键让分页稳定）。
// 只有 idx_comics_added(added_at) 时，次键会让 SQLite 放弃索引顺序、
// 改用 TEMP B-TREE 排序 —— 库大时每次翻页都要全表排序。
// schema 里补了 (added_at DESC, id) 与 (library_id, added_at DESC, id) 两个复合索引。
//
// 谁要是改了排序键（比如再加一个列），这里会直接红。
func TestListSortUsesIndex(t *testing.T) {
	dir := t.TempDir()
	ResetSingleton()
	defer ResetSingleton()
	e := env.Env{
		DataDir:  dir,
		DBFile:   filepath.Join(dir, "db", "index.db"),
		CacheDir: filepath.Join(dir, "cache"),
	}
	d := Get(e)

	const from = ` FROM comics c
	  LEFT JOIN reading_progress p ON p.comic_id = c.id
	  LEFT JOIN favorites f ON f.comic_id = c.id
	  LEFT JOIN libraries l ON l.id = c.library_id`

	cases := []struct {
		name string
		sql  string
	}{
		{"默认排序 addedAt", "SELECT c.id" + from + " WHERE 1=1 ORDER BY c.added_at DESC, c.id LIMIT 60"},
		{"库内过滤 + addedAt", "SELECT c.id" + from + " WHERE 1=1 AND c.library_id = 'lib-1' ORDER BY c.added_at DESC, c.id LIMIT 60"},
	}
	for _, c := range cases {
		rows, err := d.Prepare("EXPLAIN QUERY PLAN " + c.sql).All()
		if err != nil {
			t.Fatalf("%s: explain 失败: %v", c.name, err)
		}
		var plan []string
		for _, r := range rows {
			plan = append(plan, AsString(r, "detail"))
		}
		joined := strings.Join(plan, " | ")
		if strings.Contains(joined, "TEMP B-TREE") {
			t.Fatalf("%s 退化成临时 B 树排序（索引没被用上）:\n  %s", c.name, joined)
		}
		// 顺带确认确实用到了索引而不是全表扫
		if !strings.Contains(joined, "USING") {
			t.Fatalf("%s 查询计划里没有走索引:\n  %s", c.name, joined)
		}
		t.Logf("%s: %s", c.name, joined)
	}
}
