import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStatus, useLogin } from '@/api/queries';
import { Mascot } from '@/components/ui';

/**
 * 登录页（单账号密码门禁）。
 *
 * 触发条件：设置里打开「登录保护」后，未登录访问任何页面都会被守卫送到这里。
 * 关闭门禁时直接放行（这里也会自己跳走，避免用户手输 /login 卡住）。
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const { data: auth, isLoading } = useAuthStatus();
  const login = useLogin();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const target = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';

  // 门禁没开 / 已登录 → 不需要停留
  useEffect(() => {
    if (!isLoading && auth && (!auth.enabled || auth.authenticated)) {
      navigate(target, { replace: true });
    }
  }, [isLoading, auth, navigate, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!username.trim() || !password) {
      setErr('请输入用户名和密码');
      return;
    }
    try {
      await login.mutateAsync({ username: username.trim(), password });
      navigate(target, { replace: true });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '登录失败');
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900 p-6 shadow-2xl"
      >
        <div className="mb-6 flex flex-col items-center gap-2">
          {/* 吉祥物当门面（品牌图标已在 favicon / 桌面图标上，这里不重复摆） */}
          <Mascot kind="login" className="h-28 w-28" />
          <h1 className="text-base font-semibold text-ink-300">{auth?.username ? '肥牛漫画' : '登录肥牛漫画'}</h1>
          <p className="text-xs text-ink-500">这台设备已开启登录保护</p>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-ink-400">用户名</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-ink-400">密码</span>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {err && <p className="mb-3 text-xs text-red-400">{err}</p>}

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-lg bg-brand-600 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-60"
        >
          {login.isPending ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
