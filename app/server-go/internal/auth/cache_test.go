// 认证缓存语义测试：缓存生效、写操作立即失效、TTL 到期后回源。
package auth

import (
	"testing"
	"time"

	"fakenews-comics/internal/db"
)

// TestAuthCacheServesSession 证明会话校验真的走了缓存：
// 绕过 ResetAuthCache 直接在 DB 里删掉会话行，短时间内仍应判为有效（命中缓存）；
// TTL 到期后必须回源，读到「已删除」而拒绝。
func TestAuthCacheServesSession(t *testing.T) {
	e := testEnv(t)
	if err := SetPassword(e, "admin", "hunter2x"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	token, _, err := CreateSession(e, "admin")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, ok := ValidSession(e, token); !ok {
		t.Fatal("新会话应有效")
	}

	// 直接删 DB 行（不通知缓存）——模拟「缓存还在有效期内」
	if _, err := db.Get(e).Prepare("DELETE FROM sessions").Run(); err != nil {
		t.Fatalf("delete sessions: %v", err)
	}
	if _, ok := ValidSession(e, token); !ok {
		t.Fatal("TTL 内应命中缓存仍判有效（说明缓存没生效）")
	}

	// 等 TTL 过去 → 必须回源，读到已删除
	time.Sleep(authCacheTTL + 200*time.Millisecond)
	if _, ok := ValidSession(e, token); ok {
		t.Fatal("TTL 到期后应回源并拒绝已删除的会话")
	}
}

// TestAuthCacheInvalidatedOnLogout 登出必须立刻生效，不能等缓存过期。
func TestAuthCacheInvalidatedOnLogout(t *testing.T) {
	e := testEnv(t)
	if err := SetPassword(e, "admin", "hunter2x"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	token, _, err := CreateSession(e, "admin")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, ok := ValidSession(e, token); !ok { // 先灌进缓存
		t.Fatal("会话应有效")
	}
	if err := DeleteSession(e, token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok := ValidSession(e, token); ok {
		t.Fatal("登出后应立即失效（缓存未清）")
	}
}

// TestAuthCacheInvalidatedOnPasswordChange 改密会踢掉全部会话，缓存不能留旧结果。
func TestAuthCacheInvalidatedOnPasswordChange(t *testing.T) {
	e := testEnv(t)
	if err := SetPassword(e, "admin", "hunter2x"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	token, _, err := CreateSession(e, "admin")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, ok := ValidSession(e, token); !ok {
		t.Fatal("会话应有效")
	}
	if err := SetPassword(e, "admin", "another-pass9"); err != nil {
		t.Fatalf("SetPassword(2): %v", err)
	}
	if _, ok := ValidSession(e, token); ok {
		t.Fatal("改密后旧会话应立即失效")
	}
}

// TestAuthCacheEnabledInvalidated 开关门禁后 Enabled 应立刻反映新值。
func TestAuthCacheEnabledInvalidated(t *testing.T) {
	e := testEnv(t)
	if err := SetPassword(e, "admin", "hunter2x"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	if Enabled(e) {
		t.Fatal("初始应为关闭")
	}
	if err := SetEnabled(e, true); err != nil {
		t.Fatalf("SetEnabled(true): %v", err)
	}
	if !Enabled(e) {
		t.Fatal("开启后应立即为 true（缓存未清）")
	}
	if err := SetEnabled(e, false); err != nil {
		t.Fatalf("SetEnabled(false): %v", err)
	}
	if Enabled(e) {
		t.Fatal("关闭后应立即为 false（缓存未清）")
	}
}
