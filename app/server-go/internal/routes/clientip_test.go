package routes

import (
	"net/http/httptest"
	"testing"
)

func ipReq(remote, xff string) string {
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = remote
	if xff != "" {
		r.Header.Set("x-forwarded-for", xff)
	}
	return clientIP(r)
}

// TestClientIPIgnoresForgedXFFFromPublicClient 公网直连时不得采信 X-Forwarded-For。
//
// 回归背景：以前无条件读 XFF，攻击者每次请求伪造一个随机值即可让「10 次失败锁 5 分钟」
// 的爆破防护完全失效（每次都是新的"客户端"）。
func TestClientIPIgnoresForgedXFFFromPublicClient(t *testing.T) {
	if got := ipReq("203.0.113.9:5555", "1.2.3.4"); got != "203.0.113.9" {
		t.Fatalf("公网直连时应使用 RemoteAddr，实际 got=%q（XFF 被采信了）", got)
	}
}

// TestClientIPIgnoresForgedXFFFromLANClient 局域网设备**直连**时同样不采信 XFF。
//
// 这是上一版修复的漏网：把「私网」整体当成可信反代，于是局域网客户端自己塞一个
// X-Forwarded-For 就能换 IP，10 次失败锁 5 分钟的限流形同虚设（集成测试实测到）。
// 默认只信回环；确有局域网反代时通过 TRUSTED_PROXIES 显式放行。
func TestClientIPIgnoresForgedXFFFromLANClient(t *testing.T) {
	for _, addr := range []string{"192.168.1.23:5555", "10.0.0.5:5555", "172.17.0.1:5555"} {
		if got := ipReq(addr, "8.8.8.8"); got != remoteHost(addr) {
			t.Errorf("局域网直连 %s 不应采信 XFF，got=%q", addr, got)
		}
	}
}

// TestClientIPTrustsXFFFromLoopbackProxy 同机反代（nginx / docker -p）时按 XFF 取真实来源。
func TestClientIPTrustsXFFFromLoopbackProxy(t *testing.T) {
	if got := ipReq("127.0.0.1:5555", "1.2.3.4"); got != "1.2.3.4" {
		t.Fatalf("回环反代应采信 XFF，got=%q", got)
	}
	if got := ipReq("[::1]:5555", "1.2.3.4"); got != "1.2.3.4" {
		t.Fatalf("IPv6 回环反代应采信 XFF，got=%q", got)
	}
}

// TestClientIPTakesRightmostUntrusted 多级代理时取「最右侧的非可信地址」。
//
// nginx 的 $proxy_add_x_forwarded_for 往右追加，攻击者伪造的地址只落在左边：
//
//	XFF: 伪造的 1.2.3.4 , 真实客户端 198.51.100.7
//
// 取最左会把伪造值当客户端（限流仍可绕过），取最右非可信才正确。
func TestClientIPTakesRightmostUntrusted(t *testing.T) {
	if got := ipReq("127.0.0.1:5555", "1.2.3.4, 198.51.100.7"); got != "198.51.100.7" {
		t.Fatalf("应取最右侧非可信地址，got=%q", got)
	}
	// 全部都是可信代理时回落到 RemoteAddr
	if got := ipReq("127.0.0.1:5555", "127.0.0.1, ::1"); got != "127.0.0.1" {
		t.Fatalf("全是可信代理时应回落到来源地址，got=%q", got)
	}
}

// TestClientIPTrustedProxiesEnv 显式配置的可信反代网段要生效。
func TestClientIPTrustedProxiesEnv(t *testing.T) {
	// sync.Once 无法重置：直接调用解析函数重建列表，用完还原
	prev := trustedNets
	t.Setenv("TRUSTED_PROXIES", "172.17.0.0/16,192.168.1.0/24")
	trustedNets = nil
	parseTrustedProxies()
	defer func() { trustedNets = prev }()

	if got := ipReq("172.17.0.2:5555", "1.2.3.4"); got != "1.2.3.4" {
		t.Errorf("TRUSTED_PROXIES 里的网段应采信 XFF，got=%q", got)
	}
	if got := ipReq("192.168.1.9:5555", "5.6.7.8"); got != "5.6.7.8" {
		t.Errorf("TRUSTED_PROXIES 里的网段应采信 XFF，got=%q", got)
	}
}

// TestClientIPWithoutXFF 没有 XFF 时用 RemoteAddr；IPv6 要正确去掉端口。
func TestClientIPWithoutXFF(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:9999":    "127.0.0.1",
		"[::1]:9999":        "::1",
		"203.0.113.9:1234":  "203.0.113.9",
		"[2001:db8::1]:443": "2001:db8::1",
		"no-port-on-this":   "no-port-on-this",
	}
	for addr, want := range cases {
		if got := ipReq(addr, ""); got != want {
			t.Errorf("RemoteAddr=%s: got=%q want=%q", addr, got, want)
		}
	}
}
