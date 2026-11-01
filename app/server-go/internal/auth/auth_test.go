// 认证内核与持久化的单元测试。
package auth

import (
	"path/filepath"
	"testing"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

func TestPasswordHashAndVerify(t *testing.T) {
	salt, hash, err := HashPassword("s3cret-pass")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if salt == "" || hash == "" {
		t.Fatal("盐/散列不应为空")
	}
	if !VerifyPassword("s3cret-pass", salt, hash) {
		t.Error("正确口令应校验通过")
	}
	if VerifyPassword("wrong-pass", salt, hash) {
		t.Error("错误口令不应通过")
	}
	// 同一口令两次散列：盐不同 → 散列不同（防彩虹表/撞库）
	salt2, hash2, _ := HashPassword("s3cret-pass")
	if salt == salt2 || hash == hash2 {
		t.Error("盐应随机，两次散列不应相同")
	}
	// 非法存储形态不应 panic，直接判失败
	if VerifyPassword("s3cret-pass", "zz", "yy") {
		t.Error("损坏的盐/散列应判失败")
	}
}

func TestPasswordPolicy(t *testing.T) {
	if ValidatePassword("12345") == nil {
		t.Error("5 位应被拒")
	}
	if ValidatePassword("123456") != nil {
		t.Error("6 位应通过")
	}
	if ValidateUsername("  ") == nil {
		t.Error("空用户名应被拒")
	}
	if ValidateUsername("admin") != nil {
		t.Error("正常用户名应通过")
	}
}

func TestSessionToken(t *testing.T) {
	a, err := NewSessionToken()
	if err != nil {
		t.Fatalf("NewSessionToken: %v", err)
	}
	b, _ := NewSessionToken()
	if a == b {
		t.Error("两次 token 不应重复")
	}
	if len(a) < 32 {
		t.Errorf("token 太短: %d", len(a))
	}
	if TokenHash(a) == a {
		t.Error("库里不应存明文 token")
	}
	if TokenHash(a) != TokenHash(a) {
		t.Error("TokenHash 应稳定")
	}
}

/* ---------------- 持久化（临时 DB） ---------------- */

func testEnv(t *testing.T) env.Env {
	t.Helper()
	dir := t.TempDir()
	db.ResetSingleton()
	ResetAuthCache() // 缓存是包级变量，测试间换库必须清，否则读到上一个库的结果
	t.Cleanup(func() {
		db.ResetSingleton()
		ResetAuthCache()
	})
	return env.Env{
		DataDir:  dir,
		DBFile:   filepath.Join(dir, "db", "test.db"),
		CacheDir: filepath.Join(dir, "cache"),
	}
}

func TestStorePasswordAndSession(t *testing.T) {
	e := testEnv(t)

	// 初始：未启用、无凭据
	if Enabled(e) {
		t.Error("默认应为关闭（升级不打断现有用户）")
	}
	if _, _, _, ok := Credentials(e); ok {
		t.Error("初始不应有凭据")
	}

	if err := SetPassword(e, "admin", "hunter2x"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	name, salt, hash, ok := Credentials(e)
	if !ok || name != "admin" {
		t.Fatalf("凭据未生效: ok=%v name=%q", ok, name)
	}
	if !VerifyPassword("hunter2x", salt, hash) {
		t.Error("存取后口令应可校验")
	}

	// 开启门禁
	if err := SetEnabled(e, true); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	if !Enabled(e) {
		t.Fatal("开启后应为 true")
	}

	// 会话：创建 → 有效 → 删除 → 失效
	token, exp, err := CreateSession(e, "admin")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !exp.After(time.Now()) {
		t.Error("过期时间应在未来")
	}
	if u, ok := ValidSession(e, token); !ok || u != "admin" {
		t.Fatalf("会话应有效: ok=%v u=%q", ok, u)
	}
	if _, ok := ValidSession(e, ""); ok {
		t.Error("空 token 应无效")
	}
	if _, ok := ValidSession(e, token+"x"); ok {
		t.Error("伪造 token 应无效")
	}
	if err := DeleteSession(e, token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok := ValidSession(e, token); ok {
		t.Error("退出后会话应失效")
	}

	// 改密码会踢掉所有会话
	token2, _, _ := CreateSession(e, "admin")
	if err := SetPassword(e, "admin", "newpass99"); err != nil {
		t.Fatalf("SetPassword(2): %v", err)
	}
	if _, ok := ValidSession(e, token2); ok {
		t.Error("改密码后旧会话应失效")
	}

	// 关闭门禁也会清会话
	token3, _, _ := CreateSession(e, "admin")
	if err := SetEnabled(e, false); err != nil {
		t.Fatalf("SetEnabled(false): %v", err)
	}
	if _, ok := ValidSession(e, token3); ok {
		t.Error("关闭门禁后会话应被清空")
	}
}

func TestExpiredSession(t *testing.T) {
	e := testEnv(t)
	if err := SetPassword(e, "admin", "abcdefg"); err != nil {
		t.Fatal(err)
	}
	token, _, err := CreateSession(e, "admin")
	if err != nil {
		t.Fatal(err)
	}
	// 手工把过期时间改到过去
	if _, err := db.Get(e).Prepare("UPDATE sessions SET expires_at = ?").Run(time.Now().Add(-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, ok := ValidSession(e, token); ok {
		t.Error("过期会话应判无效")
	}
}
