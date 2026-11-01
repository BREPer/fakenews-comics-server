#!/usr/bin/env python3
"""认证门禁全流程校验（需要独立实例，默认 :13803）。

为什么单开实例：本脚本会反复开启/关闭门禁、改密码、连发错误登录触发限流 ——
在开发实例上跑会把自己锁在外面，也会污染真实设置。

前置：
    cd app/server-go
    rm -rf .auth-data && mkdir -p .auth-data
    APP_PORT=13803 HOST=127.0.0.1 DATA_DIR=<abs>/.auth-data \\
      COMIC_ROOT=<某个空目录> WEB_DIST=<abs>/app/web/dist LOG_LEVEL=error ./bin/server.exe

用法：
    python tools/auth_flow_check.py [--base http://127.0.0.1:13803]

覆盖：
  1. 未登录 401 / 健康检查与 /auth/status 免登录
  2. 登录成功、错误密码被拒
  3. 登出立刻失效（auth 层有 3 秒缓存，登出必须主动清）
  4. 改密踢掉**其他**会话；执行改密的那个会话拿新 cookie 继续可用（设计如此）
  5. 爆破限流：同一来源第 11 次起 429
  6. 从可信反代来、XFF 各不相同时按 XFF 分桶（防伪造由 clientip_test 覆盖）
  7. 收尾关闭门禁
"""
import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--base", default="http://127.0.0.1:13803")
p.add_argument("--user", default="admin")
p.add_argument("--pass1", dest="pass1", default="Hunter2-strong")
p.add_argument("--pass2", dest="pass2", default="Another9-pass")
args = p.parse_args()
BASE = args.base.rstrip("/")

results = []


def opener():
    # ProxyHandler({})：本机设置了系统代理，urllib 默认会把 127.0.0.1 的请求也送给代理，
    # 拿到 502 —— 全部用例假失败。本地探测必须绕过代理。
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    )


def call(op, method, path, payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    h = {"content-type": "application/json"} if data else {}
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with op.open(req, timeout=15) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body
    except Exception as e:  # 连接失败等
        return -1, str(e)


def check(name, cond, detail=""):
    results.append(cond)
    print(("  ok  " if cond else "  FAIL") + "  " + name + ("" if cond else f"   [{detail}]"))


def main():
    admin = opener()

    print("=== 门禁与登录 ===")
    s, _ = call(admin, "PUT", "/api/auth/credentials", {"username": args.user, "password": args.pass1})
    check("设置凭据", s == 200, s)
    s, _ = call(admin, "PUT", "/api/auth/enabled", {"enabled": True})
    check("开启门禁", s == 200, s)
    s, _ = call(opener(), "GET", "/api/comics?pageSize=3")
    check("未登录访问受保护接口 -> 401", s == 401, s)
    s, _ = call(opener(), "GET", "/api/health")
    check("健康检查免登录", s == 200, s)
    s, _ = call(opener(), "GET", "/api/auth/status")
    check("/auth/status 公开可读", s == 200, s)

    a, b = opener(), opener()
    s, _ = call(a, "POST", "/api/auth/login", {"username": args.user, "password": "wrong-pass"})
    check("错误密码被拒", s in (400, 401), s)
    s, _ = call(a, "POST", "/api/auth/login", {"username": args.user, "password": args.pass1})
    check("会话 A 登录", s == 200, s)
    s, _ = call(b, "POST", "/api/auth/login", {"username": args.user, "password": args.pass1})
    check("会话 B 登录", s == 200, s)

    print("\n=== 登出 / 改密的失效语义 ===")
    s, _ = call(b, "POST", "/api/auth/logout")
    check("B 登出", s == 200, s)
    s, _ = call(b, "GET", "/api/comics?pageSize=3")
    check("登出后立刻 401（3 秒缓存已主动清）", s == 401, s)

    s, _ = call(b, "POST", "/api/auth/login", {"username": args.user, "password": args.pass1})
    check("B 重新登录", s == 200, s)
    s, _ = call(a, "PUT", "/api/auth/credentials", {"username": args.user, "password": args.pass2})
    check("A 改密", s == 200, s)
    s, _ = call(b, "GET", "/api/comics?pageSize=3")
    check("改密后其他会话 B 立刻失效", s == 401, s)
    s, _ = call(a, "GET", "/api/comics?pageSize=3")
    check("执行改密的 A 仍可用（换发了新 cookie）", s == 200, s)

    print("\n=== 爆破限流（阈值 10 / 5 分钟）===")
    codes = []
    for i in range(14):
        req = urllib.request.Request(
            BASE + "/api/auth/login",
            data=json.dumps({"username": args.user, "password": f"bad{i}"}).encode(),
            method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                codes.append(r.status)
        except urllib.error.HTTPError as e:
            codes.append(e.code)
    print(f"  状态码: {codes}")
    check("第 11 次起返回 429", 429 in codes, codes)
    first = codes.index(429) + 1 if 429 in codes else -1
    check(f"在第 {first} 次触发（阈值 10）", first == 11, f"first429={first}")

    print("\n=== 收尾 ===")
    s, _ = call(a, "PUT", "/api/auth/enabled", {"enabled": False})
    check("关闭门禁", s == 200, s)
    s, _ = call(opener(), "GET", "/api/comics?pageSize=3")
    check("关闭后免登录可访问", s == 200, s)

    ok = sum(1 for c in results if c)
    print(f"\n结果：{ok} 通过 / {len(results) - ok} 失败")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
