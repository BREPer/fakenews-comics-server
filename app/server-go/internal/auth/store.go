// 认证相关的持久化：凭据存 settings 表（内部键），会话存 sessions 表。
//
// 为什么凭据走 settings 表而不是新建表：settings 已是 key/value + 内部键过滤的机制，
// 把 authPassHash/authSalt 加进 internalKeys 即可同时做到「不回传前端、不接受前端直写」。
package auth

import (
	"encoding/json"
	"time"

	"fakenews-comics/internal/db"
	"fakenews-comics/internal/env"
)

// settings 表内部键。
const (
	KeyEnabled  = "authEnabled"
	KeyUsername = "authUser"
	KeySalt     = "authSalt"
	KeyHash     = "authPassHash"
)

// SessionTTL 会话有效期。
const SessionTTL = 30 * 24 * time.Hour

// State 当前认证配置与请求态。
type State struct {
	Enabled       bool   `json:"enabled"`
	Authenticated bool   `json:"authenticated"`
	Username      string `json:"username,omitempty"` // 仅已登录时返回（登录页/设置页展示）
	HasCredential bool   `json:"hasCredential"`      // 是否已设过密码（决定开关能否直接打开）
}

func readSetting(e env.Env, key string) (string, bool) {
	row, err := db.Get(e).Prepare("SELECT value FROM settings WHERE key = ?").Get(key)
	if err != nil || row == nil {
		return "", false
	}
	return db.AsString(row, "value"), true
}

func writeSetting(e env.Env, key string, val any) error {
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	_, err = db.Get(e).Prepare(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).Run(key, string(b))
	return err
}

// Enabled 是否开启了登录门禁（缺省 false：升级不打断现有用户）。
// 走 3 秒缓存：门禁开启后每个 /api/* 请求都会问一次，直接打 DB 就是每张页图白付一次查询。
func Enabled(e env.Env) bool {
	return cachedEnabled(e)
}

// readEnabled 真正的 DB 读取（Enabled 的缓存底层）。
func readEnabled(e env.Env) bool {
	raw, ok := readSetting(e, KeyEnabled)
	if !ok {
		return false
	}
	var v bool
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return false
	}
	return v
}

// SetEnabled 开关门禁。关闭时清掉所有会话（避免残留 cookie 在重新开启后仍有效）。
func SetEnabled(e env.Env, on bool) error {
	defer ResetAuthCache() // 开关状态与会话都可能变，缓存立即失效
	if err := writeSetting(e, KeyEnabled, on); err != nil {
		return err
	}
	if !on {
		_, err := db.Get(e).Prepare("DELETE FROM sessions").Run()
		return err
	}
	return nil
}

// Credentials 读取已存的用户名（不含散列）。
func Credentials(e env.Env) (username string, saltHex, hashHex string, ok bool) {
	u, okU := readSetting(e, KeyUsername)
	s, okS := readSetting(e, KeySalt)
	h, okH := readSetting(e, KeyHash)
	if !okU || !okS || !okH {
		return "", "", "", false
	}
	var uname string
	_ = json.Unmarshal([]byte(u), &uname)
	var salt, hash string
	_ = json.Unmarshal([]byte(s), &salt)
	_ = json.Unmarshal([]byte(h), &hash)
	if uname == "" || salt == "" || hash == "" {
		return "", "", "", false
	}
	return uname, salt, hash, true
}

// SetPassword 设置/重置用户名与密码，并踢掉全部旧会话。
func SetPassword(e env.Env, username, password string) error {
	if err := ValidateUsername(username); err != nil {
		return err
	}
	salt, hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	defer ResetAuthCache() // 改密会踢掉全部会话，缓存必须立即失效
	d := db.Get(e)
	txErr := d.Tx(func(tx *db.Tx) error {
		for k, v := range map[string]string{
			KeyUsername: username,
			KeySalt:     salt,
			KeyHash:     hash,
		} {
			b, _ := json.Marshal(v)
			if _, err := tx.Prepare(
				"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			).Run(k, string(b)); err != nil {
				return err
			}
		}
		_, err := tx.Prepare("DELETE FROM sessions").Run()
		return err
	})
	return txErr
}

// CreateSession 新建会话，返回明文 token（仅此一次）。
func CreateSession(e env.Env, username string) (string, time.Time, error) {
	token, err := NewSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	exp := now.Add(SessionTTL)
	_, err = db.Get(e).Prepare(
		"INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)",
	).Run(TokenHash(token), username, now.UnixMilli(), exp.UnixMilli())
	if err != nil {
		return "", time.Time{}, err
	}
	return token, exp, nil
}

// ValidSession 校验 token 是否有效（带 3 秒缓存；无效结果不缓存，避免被伪造 token 刷满）。
func ValidSession(e env.Env, token string) (username string, ok bool) {
	if token == "" {
		return "", false
	}
	return cachedSession(e, token)
}

// lookupSession 真正的 DB 校验（顺带清理过期行）。
func lookupSession(e env.Env, token string) (username string, ok bool) {
	row, err := db.Get(e).Prepare(
		"SELECT username, expires_at FROM sessions WHERE token_hash = ?",
	).Get(TokenHash(token))
	if err != nil || row == nil {
		return "", false
	}
	if db.AsInt64(row, "expires_at") <= time.Now().UnixMilli() {
		_, _ = db.Get(e).Prepare("DELETE FROM sessions WHERE token_hash = ?").Run(TokenHash(token))
		return "", false
	}
	return db.AsString(row, "username"), true
}

// DeleteSession 退出登录。
func DeleteSession(e env.Env, token string) error {
	defer ResetAuthCache() // 登出必须立刻生效，不能等缓存过期
	if token == "" {
		return nil
	}
	_, err := db.Get(e).Prepare("DELETE FROM sessions WHERE token_hash = ?").Run(TokenHash(token))
	return err
}

// PruneSessions 清理过期会话（启动时调一次即可）。
func PruneSessions(e env.Env) {
	defer ResetAuthCache()
	_, _ = db.Get(e).Prepare("DELETE FROM sessions WHERE expires_at <= ?").Run(time.Now().UnixMilli())
}
