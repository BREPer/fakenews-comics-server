import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Home, Library, Search, Settings, BookMarked } from 'lucide-react';
import { BrandLogo } from '@/components/ui';
import { BackToTop } from './BackToTop';

const NAV = [
  { to: '/', label: '首页', icon: Home },
  { to: '/shelf', label: '书架', icon: BookMarked },
  { to: '/search', label: '搜索', icon: Search },
  { to: '/libraries', label: '漫画库', icon: Library },
  { to: '/settings', label: '设置', icon: Settings },
];

/**
 * 响应式应用框架（方案 §4）：
 *   ≥1024px 侧边栏（图标+文字）｜640-1023px 图标 Rail｜<640px 底部 Tab
 * 阅读器路由不走本框架（全屏独立层）。
 *
 * ⚠️ 根容器 flex 断点是 sm 不是 lg：Rail 在 640-1023px 可见，若根容器仍是 block，
 *    Rail（sticky + h-dvh）会在文档流里占满一整屏高，把主区全部顶到首屏外
 *    （平板竖屏打开只看到一排图标，就是踩过这个坑）。
 *
 * 质感要点：导航栏走半透明玻璃（页面滚动时能看到内容在下面流动），
 * 激活项用「品牌色薄底 + 左侧指示条 + 图标微光」三重信号，而不是只换个字色。
 */
export default function AppShell() {
  const { pathname } = useLocation();

  const brand = (
    <div className="flex items-center gap-2.5 px-3 py-4">
      <BrandLogo size={32} className="shadow-soft" />
      <span className="text-base font-bold tracking-wide">肥牛漫画</span>
    </div>
  );

  /** 侧栏 / Rail 的导航项：激活态 = 品牌色薄底 + 左侧指示条 + 图标发光 */
  const navItems = (compact: boolean) =>
    NAV.map(({ to, label, icon: Icon }) => (
      <NavLink
        key={to}
        to={to}
        end={to === '/'}
        className={({ isActive }) =>
          `group relative flex items-center gap-3 rounded-xl text-sm font-medium
           transition-[background-color,color,transform] duration-200 ease-out-quint active:scale-[0.97] ${
             isActive
               ? 'bg-brand-500/10 text-accent'
               : 'text-ink-400 hover:bg-ink-800/70 hover:text-ink-200'
           } ${compact ? 'justify-center p-3' : 'px-3 py-2.5'}`
        }
        title={label}
      >
        {({ isActive }) => (
          <>
            {!compact && (
              <span
                className={`absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand-600 transition-all duration-200 ease-out-quint dark:bg-brand-500 ${
                  isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0'
                }`}
              />
            )}
            <Icon
              size={20}
              className={`transition-[filter,transform] duration-200 ${
                isActive ? 'drop-shadow-[0_0_6px_rgb(var(--brand-500)/0.45)]' : ''
              }`}
            />
            {!compact && <span>{label}</span>}
          </>
        )}
      </NavLink>
    ));

  return (
    <div className="min-h-dvh sm:flex">
      {/* 桌面：侧边栏（玻璃 + 极淡右边框） */}
      <aside className="glass sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-ink-800/60 lg:flex">
        {brand}
        <nav className="flex flex-col gap-0.5 px-4">{navItems(false)}</nav>
        <div className="mt-auto px-4 py-4 text-[11px] leading-relaxed text-ink-600">
          肥牛漫画 · fnOS
          <br />
          本地漫画库阅读器
        </div>
      </aside>

      {/* 平板：图标 Rail */}
      <aside className="glass sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-ink-800/60 sm:flex lg:hidden">
        <div className="flex justify-center py-4">
          <BrandLogo size={32} className="shadow-soft" />
        </div>
        <nav className="flex flex-col items-center gap-1 px-2">{navItems(true)}</nav>
      </aside>

      {/* 主区：路由切换时整块内容淡入上浮（key 变化触发重挂载） */}
      <div className="flex min-w-0 flex-1 flex-col pb-[calc(4.25rem+env(safe-area-inset-bottom))] sm:pb-0">
        <main key={pathname} className="anim-route mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-5 sm:py-6">
          <Outlet />
        </main>
      </div>

      {/*
        移动：底部 Tab。
        背景保持**透明**（只用 backdrop-blur 做毛玻璃），不压实色底：
        之前写成 bg-ink-900/92 —— /92 不在 Tailwind 的 opacity 刻度里，那条规则压根没生成，
        于是它是「纯 blur」的观感；后来我把它改成有效的 /90 变成了实色底，用户明确表示要回到透明。
        这里直接不写背景色，避免再被「看起来像无效值」误导。
      */}
      <nav className="fixed inset-x-0 bottom-0 z-[var(--layer-nav)] flex border-t border-ink-800/70 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors duration-200 active:scale-[0.95] ${
                isActive ? 'text-accent' : 'text-ink-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`absolute top-0 h-[2px] w-8 rounded-full bg-brand-600 transition-all duration-200 ease-out-quint dark:bg-brand-500 ${
                    isActive ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0'
                  }`}
                />
                <Icon
                  size={20}
                  className={`transition-transform duration-200 ease-spring ${isActive ? '-translate-y-px' : ''}`}
                />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* 回到顶部：阅读器路由不走本框架，所以全屏阅读时不会出现 */}
      <BackToTop />
    </div>
  );
}
