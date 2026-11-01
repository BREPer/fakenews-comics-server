// Package auth 单账号门禁：口令散列、会话 token。
//
// 设计取舍：
//   - 口令用 PBKDF2-HMAC-SHA256（stdlib crypto/pbkdf2，Go 1.24+），不引第三方依赖——
//     与「无 CGO、可交叉编译、单二进制」的部署约束一致（bcrypt/argon2 都要额外依赖或 CGO）
//   - 会话 token 用 32 字节随机数，DB 里只存 SHA-256 散列：DB 被拷走也不能直接冒用会话
//   - 迭代次数取 OWASP 2023 建议量级（210k）@ 32 字节输出
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	// Iterations PBKDF2 迭代次数（OWASP 建议 ≥ 210k for PBKDF2-HMAC-SHA256）。
	Iterations = 210_000
	// keyLen 派生密钥长度（字节）。
	keyLen = 32
	// SaltLen 盐长度（字节）。
	SaltLen = 16
	// MinPasswordLen 最短密码长度。
	MinPasswordLen = 6
	// MaxPasswordLen 最长密码长度（防止拿超长口令拖死 PBKDF2）。
	MaxPasswordLen = 256
	// MaxUsernameLen 最长用户名长度。
	MaxUsernameLen = 64
)

// ErrWeakPassword 口令不合规。
var ErrWeakPassword = fmt.Errorf("password must be %d-%d characters", MinPasswordLen, MaxPasswordLen)

// ErrBadUsername 用户名不合规。
var ErrBadUsername = errors.New("username must be 1-64 characters")

// HashPassword 生成盐与派生散列（均 hex 编码）。
func HashPassword(password string) (saltHex, hashHex string, err error) {
	if err := ValidatePassword(password); err != nil {
		return "", "", err
	}
	salt := make([]byte, SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, Iterations, keyLen)
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(salt), hex.EncodeToString(key), nil
}

// VerifyPassword 常量时间比对口令散列。
func VerifyPassword(password, saltHex, hashHex string) bool {
	salt, err := hex.DecodeString(saltHex)
	if err != nil || len(salt) == 0 {
		return false
	}
	want, err := hex.DecodeString(hashHex)
	if err != nil || len(want) != keyLen {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, Iterations, keyLen)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ValidatePassword 口令长度校验。
func ValidatePassword(password string) error {
	if len(password) < MinPasswordLen || len(password) > MaxPasswordLen {
		return ErrWeakPassword
	}
	return nil
}

// ValidateUsername 用户名校验（去空白后非空且不超长）。
func ValidateUsername(username string) error {
	u := strings.TrimSpace(username)
	if u == "" || len(u) > MaxUsernameLen {
		return ErrBadUsername
	}
	return nil
}

// NewSessionToken 生成会话 token（32 字节 base64url，无填充）。
func NewSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// TokenHash 会话 token 的存储形态（DB 只存散列）。
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
