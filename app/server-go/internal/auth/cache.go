// 认证状态的短 TTL 缓存。
//
// 门禁开启后，每个 /api/* 请求都要查两次 DB：一次 authEnabled、一次 sessions。
// 阅读器一屏要拉多张页图，等于每张图白付 2 次 SQLite 查询（WAL 下虽快，但仍是
// 连接池 + 语句缓存上的额外竞争）。
//
// 这里缓存 3 秒。所有会改变认证状态的写入口（登录、登出、改密、开关门禁、
// 启动清理）都主动清空缓存，所以「改完立刻生效」；唯一被放宽的是会话**自然到期**，
// 最多晚 3 秒被拒 —— 会话 TTL 是 30 天，这个偏差没有实际影响。
package auth

import (
	"sync"
	"time"

	"fakenews-comics/internal/env"
)

const authCacheTTL = 3 * time.Second

// sessionCacheMax 上限：防止伪造 token 的请求把缓存撑爆。
const sessionCacheMax = 4096

type enabledCacheEntry struct {
	val bool
	at  time.Time
	ok  bool
}

type sessionCacheEntry struct {
	username string
	at       time.Time
}

var (
	authCacheMu  sync.Mutex
	enabledEntry enabledCacheEntry
	// key 是 token 的 SHA-256（与 DB 存的形态一致），不在内存里留明文 token
	sessionCache = map[string]sessionCacheEntry{}
)

// ResetAuthCache 清空认证缓存。登录 / 登出 / 改密 / 切换门禁 / 清理过期会话后调用。
func ResetAuthCache() {
	authCacheMu.Lock()
	defer authCacheMu.Unlock()
	enabledEntry = enabledCacheEntry{}
	sessionCache = map[string]sessionCacheEntry{}
}

// cachedEnabled 返回门禁开关（带缓存）。
func cachedEnabled(e env.Env) bool {
	authCacheMu.Lock()
	if enabledEntry.ok && time.Since(enabledEntry.at) < authCacheTTL {
		v := enabledEntry.val
		authCacheMu.Unlock()
		return v
	}
	authCacheMu.Unlock()

	v := readEnabled(e) // 真正的 DB 读取

	authCacheMu.Lock()
	enabledEntry = enabledCacheEntry{val: v, at: time.Now(), ok: true}
	authCacheMu.Unlock()
	return v
}

// cachedSession 返回会话对应的用户名（带缓存），无效时 ok=false。
func cachedSession(e env.Env, token string) (string, bool) {
	h := TokenHash(token)
	authCacheMu.Lock()
	if en, hit := sessionCache[h]; hit && time.Since(en.at) < authCacheTTL {
		authCacheMu.Unlock()
		return en.username, true
	}
	authCacheMu.Unlock()

	user, ok := lookupSession(e, token)
	if !ok {
		return "", false
	}

	authCacheMu.Lock()
	if len(sessionCache) >= sessionCacheMax {
		sessionCache = map[string]sessionCacheEntry{}
	}
	sessionCache[h] = sessionCacheEntry{username: user, at: time.Now()}
	authCacheMu.Unlock()
	return user, true
}
