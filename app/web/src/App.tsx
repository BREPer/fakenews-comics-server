import { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ScrollManager from './components/layout/ScrollManager';
import { useApplyDevicePrefs } from './hooks';
import RequireAuth from './components/auth/RequireAuth';
import HomePage from './pages/Home';
import { Loading } from './components/ui';
import { ToastHost } from './components/ui/toast';
import SearchPage from './pages/Search';
import DetailPage from './pages/Detail';
import ShelfPage from './pages/Shelf';
import SettingsPage from './pages/Settings';
import ReaderPage from './pages/Reader';
import LibrariesPage from './pages/Libraries';
import LoginPage from './pages/Login';
import NotFoundPage from './pages/NotFound';

/**
 * 路由表（方案 §4 信息架构）。
 * 阅读器脱离 AppShell 全屏渲染；其余页面共享响应式框架。
 *
 * 为什么不按路由懒加载（曾经分 7 个 chunk，已改回静态导入）：
 *   实测在 React 19 下，`React.lazy` + 外层 <Suspense> 会在「chunk 已到达」之后
 *   再空转约 300ms 才挂载组件——`/read/...` 冷启动 chunk 于 292ms 取回，
 *   首批接口却到 595ms 才发出；改成静态导入后同一路径变成 366ms（-250ms）。
 *   详情页 371ms → 677ms 是同一现象。
 *   代价是把 7 个 chunk（合计约 18KB gz）并回主包；局域网下这点字节远小于 300ms。
 *
 * 登录：`/login` 放在守卫之外（否则会自己拦自己），其余路由全部包在 RequireAuth 里。
 * 门禁关闭时守卫只多一次状态查询，行为与之前完全一致。
 */

/** 受保护的业务路由表 */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/read/:comicId/:chapterId" element={<ReaderPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/comic/:comicId" element={<DetailPage />} />
        <Route path="/shelf" element={<ShelfPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/libraries" element={<LibrariesPage />} />
        {/* 404 放在 AppShell 内：底栏导航还在，用户不用靠浏览器后退逃生。
            以前这里是静默 <Navigate to="/">，输错地址什么反馈都没有。 */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  // 外观（主题/高亮色）与旧数据迁移都走本机偏好，放在最外层：
  // 登录页也要正确的配色，而且它们不再依赖任何服务端请求
  useApplyDevicePrefs();

  return (
    <>
      <Suspense fallback={<Loading label="加载中…" />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                {/* 外观/高亮色由 App 根部的 useApplyDevicePrefs 负责，这里只留滚动与路由 */}
                <ScrollManager />
                <AppRoutes />
              </RequireAuth>
            }
          />
        </Routes>
      </Suspense>
      {/* 轻提示挂在路由之外：登录页、阅读器（全屏层）里同样要能看到操作结果 */}
      <ToastHost />
    </>
  );
}
