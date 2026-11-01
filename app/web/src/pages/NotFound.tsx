import { Link } from 'react-router-dom';
import { Mascot } from '@/components/ui';

/**
 * 404 页。
 *
 * 以前 `*` 路由是静默重定向回首页——用户输错地址 / 点了失效链接时
 * 什么反馈都没有，像被「悄悄弹走」。现在给一张吉祥物从书后探出头的
 * 插画（与素材 status-404 的「404 气泡」呼应）和一个明确的回首页出口。
 * 放在 AppShell 内而不是独立全页：底栏导航还在，用户可以直接点去别处。
 */
export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <Mascot kind="404" className="h-44 w-44" />
      <p className="text-base font-semibold text-ink-300">这一页走丢了呢</p>
      <p className="max-w-xs text-xs leading-relaxed text-ink-500">
        地址不存在，或内容已被移动、删除
      </p>
      <Link to="/" className="btn-primary mt-1">
        回首页
      </Link>
    </div>
  );
}
