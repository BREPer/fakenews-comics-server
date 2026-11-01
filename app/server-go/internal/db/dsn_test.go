package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"runtime"
	"testing"
)

// TestBuildDSNPragmasOnEveryConnection 验证 pragma 真的作用于连接池里的**每一条**连接。
//
// 回归背景：以前是在 `sql.Open` 之后对 `*sql.DB` 执行一遍 `PRAGMA ...`，
// 但 PRAGMA 是按连接生效的 —— 池里只有执行时那一条连接被设置过，其余连接
// 全是默认值（foreign_keys=OFF / busy_timeout=0）。表现是外键级联静默失效、
// 并发写偶尔 SQLITE_BUSY。改成写进 DSN（_pragma=name(value)）后每连接自动应用。
func TestBuildDSNPragmasOnEveryConnection(t *testing.T) {
	file := filepath.Join(t.TempDir(), "pragma.db")
	raw, err := sql.Open("sqlite", buildDSN(file))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer raw.Close()

	const n = 4
	raw.SetMaxOpenConns(n)
	ctx := context.Background()

	// 同时占住 n 条连接，确保检查的是不同连接而不是复用同一条
	conns := make([]*sql.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := raw.Conn(ctx)
		if err != nil {
			t.Fatalf("conn %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()

	for i, c := range conns {
		var fk int
		if err := c.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
			t.Fatalf("conn %d foreign_keys: %v", i, err)
		}
		if fk != 1 {
			t.Errorf("conn %d: foreign_keys = %d，期望 1（pragma 没落到这条连接上）", i, fk)
		}

		var busy int
		if err := c.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busy); err != nil {
			t.Fatalf("conn %d busy_timeout: %v", i, err)
		}
		if busy != 3000 {
			t.Errorf("conn %d: busy_timeout = %d，期望 3000", i, busy)
		}

		var journal string
		if err := c.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil {
			t.Fatalf("conn %d journal_mode: %v", i, err)
		}
		if journal != "wal" {
			t.Errorf("conn %d: journal_mode = %q，期望 wal", i, journal)
		}
	}
}

// TestBuildDSNWithExistingQuery 路径里已带 `?` 时应改用 `&` 追加。
func TestBuildDSNWithExistingQuery(t *testing.T) {
	got := buildDSN("file:/tmp/x.db?mode=ro")
	if want := "file:/tmp/x.db?mode=ro&_pragma=journal_mode(WAL)"; len(got) < len(want) || got[:len(want)] != want {
		t.Fatalf("buildDSN 追加参数格式不对: %s", got)
	}
	if runtime.GOOS == "windows" && got[len(got)-1] == '&' {
		t.Fatalf("尾部多余的 & : %s", got)
	}
}
