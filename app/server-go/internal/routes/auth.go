// 登录门禁：状态查询、登录、退出、凭据设置、开关，以及 API 层拦截中间件。
//
// 边界（与产品约定一致）：
//   - 默认**不启用**（升级不打断现有用户）；启用后只拦 `/api/*`，
//     静态资源与 SPA 放行——否则登录页自己都加载不出来
//   - 豁免：/api/health（容器健康检查）、/api/auth/*（登录本身）
//   - 单账号：进度/收藏/书架仍是全库共享，不做 per-user 隔离
package routes

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"fakenews-comics/internal/auth"
	"fakenews-comics/internal/env"
	"fakenews-comics/internal/httputil"
	"fakenews-comics/internal/lib"
	"fakenews-comics/internal/logger"
)

// sessionCookie 会话 Cookie 名。
const sessionCookie = "fakenews_session"

// 登录失败限流：同一 IP 连错 10 次 → 锁 5 分钟（NAS 常暴露在局域网，防暴力猜弱口令）。
const (
	loginMaxFailures = 10
	loginLockWindow  = 5 * time.Minute
)

type loginGuard struct {
	mu    sync.Mutex
	fails map[string][]time.Time
}

var guard = &loginGuard{fails: map[string][]time.Time{}}

// allow 尝试记一次失败；返回 false 表示已被锁。
func (g *loginGuard) allow(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	kept := g.fails[ip][:0]
	for _, t := range g.fails[ip] {
		if now.Sub(t) < loginLockWindow {
			kept = append(kept, t)
		}
	}
	g.fails[ip] = kept
	return len(kept) < loginMaxFailures
}

func (g *loginGuard) fail(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fails[ip] = append(g.fails[ip], time.Now())
}

func (g *loginGuard) reset(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.fails, ip)
}

// clientIP 取客户端地址（登录爆破限流按它计数）。
//
// 安全要点：X-Forwarded-For 是**客户端可任意伪造**的 header。以前无条件采信它，
// 每次请求换一个随机 XFF 就能把「10 次失败锁 5 分钟」变成摆设。
//
// 现在的规则分两层：
//   1. 来源不在可信反代列表里 → 完全忽略 XFF，用 RemoteAddr。
//      默认列表只有回环（同机 nginx / docker -p 反代）。**默认不含私网**：
//      局域网设备直连时 RemoteAddr 本身就是 192.168.x.x，若把私网一律当反代，
//      客户端自己塞一个 X-Forwarded-For 就能绕过限流（这条实测过，是上一版修复的漏网）。
//      确实有局域网反代时用 TRUSTED_PROXIES="172.17.0.0/16,..." 显式放行。
//   2. 来源可信时，XFF 从**右往左**取第一个非可信地址。
//      nginx 的 $proxy_add_x_forwarded_for 是往右追加，所以攻击者伪造的地址只会落在
//      左边；取最左会把伪造值当客户端，取最右非可信才是真实客户端。
func clientIP(r *http.Request) string {
	host := remoteHost(r.RemoteAddr)
	if !isTrustedProxy(host) {
		return host
	}
	xff := r.Header.Get("x-forwarded-for")
	if xff == "" {
		return host
	}
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		v := strings.TrimSpace(parts[i])
		if v == "" {
			continue
		}
		if !isTrustedProxy(v) {
			return v
		}
	}
	return host
}

// remoteHost 从 "ip:port" / "[::1]:port" 里取出 host 部分。
func remoteHost(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

var (
	trustedOnce sync.Once
	trustedNets []*net.IPNet
)

// loadTrustedProxies 懒加载可信反代网段（进程内只解析一次）。
func loadTrustedProxies() {
	trustedOnce.Do(parseTrustedProxies)
}

// parseTrustedProxies 解析可信反代网段：默认回环，可用 TRUSTED_PROXIES 追加（逗号分隔 CIDR）。
// 拆出来是为了测试能重放（sync.Once 无法重置）。
func parseTrustedProxies() {
	for _, c := range append([]string{"127.0.0.1/32", "::1/128"}, strings.Split(os.Getenv("TRUSTED_PROXIES"), ",")...) {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !strings.Contains(c, "/") {
			c += "/32" // 允许直接写单个 IP
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			trustedNets = append(trustedNets, n)
		}
	}
}

// isTrustedProxy 判断地址是否在可信反代列表内（默认只有回环）。
func isTrustedProxy(host string) bool {
	loadTrustedProxies()
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, n := range trustedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// CSRFGate 拒绝浏览器发起的跨站/同站跨端口写请求。
//
// SameSite=Lax 只挡跨站；NAS 上常见的「同站不同端口」服务仍会带上会话 Cookie，
// 而写接口以前不校验来源，text/plain 也能把 JSON 投进来。
// 现代浏览器会为写请求带 Sec-Fetch-Site；没有该头的旧客户端再用 Origin 兜底。
// curl / 探针两个头都没有，保持可用（它们本来就不受同源策略约束）。
func CSRFGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
			if site != "same-origin" && site != "none" {
				httputil.WriteError(w, http.StatusForbidden, 4030, "cross-site request blocked")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				httputil.WriteError(w, http.StatusForbidden, 4030, "cross-site request blocked")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// AuthGate 包装 mux：启用门禁且无有效会话时，对受保护的 /api/* 返回 401。
func AuthGate(e env.Env) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// 静态资源与 SPA 一律放行：登录页需要它们才能渲染
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			if isPublicAPI(r.URL.Path) || !auth.Enabled(e) {
				next.ServeHTTP(w, r)
				return
			}
			if _, ok := currentUser(e, r); ok {
				next.ServeHTTP(w, r)
				return
			}
			httputil.WriteError(w, http.StatusUnauthorized, 4010, "login required")
		})
	}
}

// isPublicAPI 无需登录的接口。
func isPublicAPI(p string) bool {
	switch {
	case p == "/api/health": // 容器健康检查
		return true
	case strings.HasPrefix(p, "/api/auth/"): // 登录页要用
		return true
	}
	return false
}

// currentUser 从 Cookie 解析当前登录用户。
func currentUser(e env.Env, r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return "", false
	}
	return auth.ValidSession(e, c.Value)
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, exp time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil, // NAS 多为 http，强制 Secure 会让登录直接不可用
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func registerAuth(mux *http.ServeMux, e env.Env) {
	// GET /api/auth/status —— 公开：登录页判断要不要显示登录、当前是否已登录
	mux.HandleFunc("GET /api/auth/status", adapt(func(w http.ResponseWriter, r *http.Request) error {
		st := auth.State{Enabled: auth.Enabled(e)}
		_, _, _, st.HasCredential = auth.Credentials(e)
		if u, ok := currentUser(e, r); ok {
			st.Authenticated = true
			st.Username = u
		}
		httputil.WriteData(w, st)
		return nil
	}))

	// POST /api/auth/login
	mux.HandleFunc("POST /api/auth/login", adapt(func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		ip := clientIP(r)
		if !guard.allow(ip) {
			return lib.Errorf(http.StatusTooManyRequests, 4290, "too many failed attempts, try again later")
		}
		name, salt, hash, ok := auth.Credentials(e)
		if !ok || !auth.Enabled(e) {
			return lib.BadRequest("login is not enabled")
		}
		// 用户名与密码都错时返回同一句话：不泄漏「用户名对不对」
		if body.Username != name || !auth.VerifyPassword(body.Password, salt, hash) {
			guard.fail(ip)
			logger.Warn("login failed", "user", body.Username, "ip", ip)
			return lib.Errorf(http.StatusUnauthorized, 4010, "wrong username or password")
		}
		guard.reset(ip)
		token, exp, err := auth.CreateSession(e, name)
		if err != nil {
			return err
		}
		setSessionCookie(w, r, token, exp)
		logger.Info("login success", "user", name, "ip", ip)
		httputil.WriteData(w, map[string]any{"ok": true, "username": name})
		return nil
	}))

	// POST /api/auth/logout
	mux.HandleFunc("POST /api/auth/logout", adapt(func(w http.ResponseWriter, r *http.Request) error {
		if c, err := r.Cookie(sessionCookie); err == nil {
			_ = auth.DeleteSession(e, c.Value)
		}
		clearSessionCookie(w)
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// PUT /api/auth/credentials —— 设置/修改用户名密码（首次开启时用）
	mux.HandleFunc("PUT /api/auth/credentials", adapt(func(w http.ResponseWriter, r *http.Request) error {
		// 已启用时必须先登录（否则任何人都能改密码）
		if auth.Enabled(e) {
			if _, ok := currentUser(e, r); !ok {
				return lib.Errorf(http.StatusUnauthorized, 4010, "login required")
			}
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		if err := auth.ValidateUsername(body.Username); err != nil {
			return lib.BadRequest("username must be 1-64 characters")
		}
		if err := auth.ValidatePassword(body.Password); err != nil {
			return lib.BadRequest(err.Error())
		}
		if err := auth.SetPassword(e, strings.TrimSpace(body.Username), body.Password); err != nil {
			return err
		}
		logger.Info("credentials updated", "user", strings.TrimSpace(body.Username))
		// 改密码会踢掉全部会话：给当前请求重新发一张，避免用户改完自己被踢
		if auth.Enabled(e) {
			token, exp, err := auth.CreateSession(e, strings.TrimSpace(body.Username))
			if err == nil {
				setSessionCookie(w, r, token, exp)
			}
		}
		httputil.WriteData(w, map[string]any{"ok": true})
		return nil
	}))

	// PUT /api/auth/enabled —— 开关门禁
	mux.HandleFunc("PUT /api/auth/enabled", adapt(func(w http.ResponseWriter, r *http.Request) error {
		if auth.Enabled(e) {
			if _, ok := currentUser(e, r); !ok {
				return lib.Errorf(http.StatusUnauthorized, 4010, "login required")
			}
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := httputil.DecodeJSON(r, &body); err != nil {
			return lib.BadRequest("invalid json body")
		}
		if body.Enabled {
			// 没有密码就开门 = 把自己锁在外面，直接拒
			if _, _, _, ok := auth.Credentials(e); !ok {
				return lib.BadRequest("set username and password first")
			}
		}
		if err := auth.SetEnabled(e, body.Enabled); err != nil {
			return err
		}
		logger.Info("auth toggled", "enabled", body.Enabled)
		// 开启后当前请求要能继续用：补一张会话
		if body.Enabled {
			name, _, _, _ := auth.Credentials(e)
			if token, exp, err := auth.CreateSession(e, name); err == nil {
				setSessionCookie(w, r, token, exp)
			}
		}
		httputil.WriteData(w, map[string]any{"enabled": body.Enabled})
		return nil
	}))
}
