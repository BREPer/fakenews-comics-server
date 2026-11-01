import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useAuthStatus } from '@/api/queries';
import { Loading } from '@/components/ui';
import BootShell from '@/components/layout/BootShell';
import { useDelayedShow } from '@/hooks';

/**
 * 首屏守卫先「沿用启动壳」多久，超过才换成带吉祥物的等待页。
 *
 * 为什么不是直接显示等待页（2026-10-28 限速实测）：
 *   - 弱网（1 Mbps / RTT 150ms）下这一屏只活 **206ms**，而吉祥物从挂载到完全可见要
 *     320ms（门槛 200 + 淡入 120）→ 她物理上不来；屏幕上只剩「骨架被换成裸 spinner」这一
 *     次降级，比原样保留骨架难看。
 *   - NAS 唤醒（RTT 600ms）下这一屏活 **645ms**，这时骨架干等着反而像卡住，
 *     换成「吉祥物 + 正在检查登录状态…」才有信息量。
 * 600ms 正好卡在两者之间：短的直接由骨架过渡到首页（无接缝），长的才换页。
 */
const SHELL_HOLD_MS = 600;

/**
 * 登录守卫：门禁开启且未登录时，把任何页面重定向到 /login（并记住来路）。
 *
 * 另外监听 client 层的 `fn:unauthorized` 事件：会话过期时任何接口返回 401，
 * 都会让守卫重新拉一次状态，从而统一跳登录页——避免每个页面各写一遍处理。
 */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const qc = useQueryClient();
  const { data, isLoading } = useAuthStatus();
  // hook 必须无条件调用：放在下面的 early return 之后会违反 hooks 规则
  const shellHoldOver = useDelayedShow(SHELL_HOLD_MS);

  useEffect(() => {
    const onUnauthorized = () => {
      void qc.invalidateQueries({ queryKey: queryKeys.auth() });
    };
    window.addEventListener('fakenews:unauthorized', onUnauthorized);
    return () => window.removeEventListener('fakenews:unauthorized', onUnauthorized);
  }, [qc]);

  if (isLoading) {
    // 先用骨架顶住（与 index.html 里那份静态壳同构，切换时看不出接缝）；
    // 等得久了才换成等待页 —— 一旦换页，吉祥物就该立刻在场，不再压第二道门槛。
    return shellHoldOver ? <Loading label="正在检查登录状态…" variant="after-boot" /> : <BootShell />;
  }

  if (data?.enabled && !data.authenticated) {
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}
