// Package db SQLite 兼容层：modernc.org/sqlite（纯 Go，无 CGO，容器/本地同构、可交叉编译）。
// 对外提供类 database/sql 的门面：Prepare().Run/Get/All + Transaction。
// pragma 设置（WAL / NORMAL / temp_store / 16MB 页缓存）。
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"

	"fakenews-comics/internal/env"
)

//go:embed schema.sql
var schemaFS embed.FS

const stmtCacheMax = 256

// DB 数据库门面（单例）。
type DB struct {
	raw    *sql.DB
	mu     sync.Mutex
	stmts  map[string]*sql.Stmt
	closed bool
}

var instance *DB

// Get 打开（或返回已打开的）单例。建库 + schema + 迁移一次完成。
func Get(e env.Env) *DB {
	if instance != nil {
		return instance
	}
	if err := os.MkdirAll(filepath.Dir(e.DBFile), 0o755); err != nil {
		panic(fmt.Sprintf("db: mkdir: %v", err))
	}
	raw, err := sql.Open("sqlite", buildDSN(e.DBFile))
	if err != nil {
		panic(fmt.Sprintf("db: open: %v", err))
	}
	// 连接池：WAL 下读可并发。
	// 注意 pragma 必须写在 DSN 里（见 buildDSN）——PRAGMA 是**按连接**生效的，
	// 在池里执行一次只作用于当时那一条连接，其余连接会退化成
	// foreign_keys=OFF / busy_timeout=0（外键级联静默失效、并发写直接 SQLITE_BUSY）。
	raw.SetMaxOpenConns(4)
	d := &DB{raw: raw, stmts: make(map[string]*sql.Stmt)}
	if _, err := raw.Exec(string(mustSchema())); err != nil {
		panic(fmt.Sprintf("db: schema: %v", err))
	}
	instance = d
	return d
}

func mustSchema() []byte {
	b, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		panic(err)
	}
	return b
}

// buildDSN 把连接级 pragma 拼进 DSN。
//
// modernc.org/sqlite 会把 `_pragma=name(value)` 在这条连接**建立时**执行，
// 于是池里每一条连接都带上相同设置 —— 这正是 PRAGMA 语义需要的（按连接生效）。
//
// WAL + NORMAL：写事务不再每次 fsync（异常掉电最多丢最后一个事务，不会损坏库）。
// busy_timeout 3s：并发写时等锁而不是立刻报错。
func buildDSN(file string) string {
	sep := "?"
	if strings.Contains(file, "?") {
		sep = "&"
	}
	return file + sep + strings.Join([]string{
		"_pragma=journal_mode(WAL)",
		"_pragma=foreign_keys(1)",
		"_pragma=busy_timeout(3000)",
		"_pragma=synchronous(NORMAL)",
		"_pragma=temp_store(MEMORY)",
		"_pragma=cache_size(-16000)",
	}, "&")
}

// Stmt 编译后的语句门面（FIFO 缓存，热接口省掉每次解析 SQL）。
type Stmt struct {
	raw *sql.Stmt
}

// Prepare 取（或编译并缓存）语句。
func (d *DB) Prepare(query string) *Stmt {
	d.mu.Lock()
	if s, ok := d.stmts[query]; ok {
		d.mu.Unlock()
		return &Stmt{raw: s}
	}
	s, err := d.raw.Prepare(query)
	if err != nil {
		d.mu.Unlock()
		panic(fmt.Sprintf("db: prepare %q: %v", query, err))
	}
	if len(d.stmts) >= stmtCacheMax {
		// FIFO：丢最旧（语句句柄很轻，不需要 LRU 那么精细）
		for k := range d.stmts {
			delete(d.stmts, k)
			break
		}
	}
	d.stmts[query] = s
	d.mu.Unlock()
	return &Stmt{raw: s}
}

// Exec 直接执行（无结果集语句）。
func (d *DB) Exec(query string) error {
	_, err := d.raw.Exec(query)
	return err
}

// Run 执行写语句，返回受影响行数。
func (s *Stmt) Run(args ...any) (int64, error) {
	r, err := s.raw.Exec(args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// Get 查询单行，无结果返回 nil（不报错）。
func (s *Stmt) Get(args ...any) (map[string]any, error) {
	rows, err := s.raw.Query(args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, nil
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	out := make(map[string]any, len(cols))
	for i, c := range cols {
		out[c] = normalize(vals[i])
	}
	return out, nil
}

// All 查询全部行。
func (s *Stmt) All(args ...any) ([]map[string]any, error) {
	rows, err := s.raw.Query(args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			row[c] = normalize(vals[i])
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// normalize 驱动返回值 → JSON 友好类型（[]byte→string 等）。
func normalize(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	default:
		return v
	}
}

// Tx 同步事务：失败整体回滚。
func (d *DB) Tx(fn func(tx *Tx) error) error {
	raw, err := d.raw.Begin()
	if err != nil {
		return err
	}
	tx := &Tx{raw: raw}
	if err := fn(tx); err != nil {
		_ = raw.Rollback()
		return err
	}
	return raw.Commit()
}

// Tx 事务内语句门面（不走缓存，事务专用）。
type Tx struct {
	raw *sql.Tx
}

// Prepare 事务内语句。
func (t *Tx) Prepare(query string) *Stmt {
	s, err := t.raw.Prepare(query)
	if err != nil {
		panic(fmt.Sprintf("db: tx prepare %q: %v", query, err))
	}
	return &Stmt{raw: s}
}

// Close 关闭数据库。
func (d *DB) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return nil
	}
	d.closed = true
	for _, s := range d.stmts {
		_ = s.Close()
	}
	return d.raw.Close()
}

// ResetSingleton 关闭并清空单例（测试用：每个测试需要独立 DB）。
func ResetSingleton() {
	if instance != nil {
		_ = instance.Close()
		instance = nil
	}
}
