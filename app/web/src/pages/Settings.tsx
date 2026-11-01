import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useSettings, useSaveSettings, useTriggerScan, useCacheStats, useClearCache, useEvictCache, useAbout,
  useAuthStatus, useSetAuthEnabled, useSetCredentials, useLogout,
} from '@/api/queries';
import { Row, Segmented, Toggle } from '@/components/ui/settings-controls';
import { api } from '@/api/client';
import { useDevicePrefs } from '@/hooks';
import { applyDevicePrefs, devicePrefsSnapshot } from '@/utils/devicePrefs';
import { Check } from 'lucide-react';
import { BrandLogo, ErrorState, Loading, Mascot } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import type { DevicePrefs, Settings } from '@/types';

/**
 * 高亮色选项。色板用的是各色相的「中亮→深」渐变（与按钮同款），
 * 而不是单色块——单色在白底/深底上总有一边看起来发灰。
 * 色值对应 index.css 的 --brand-grad-from/to（浅色主题下那一套）；
 * hex 取各自 500 档，用作选中环（标准色太浅的色相，浅色底上那圈会看不见）。
 * 空色的标准色 #A0D8EF 太浅（白字只有 1.55:1），落在 200 档当浅底强调，
 * 这里渐到实心主色 600，白勾在色板上才看得清。
 */
const ACCENT_OPTIONS = [
  { value: 'amber', label: '琥珀橙', grad: 'linear-gradient(140deg, #fb923c, #ea580c)', hex: '#f97316' },
  { value: 'sora', label: '空色', grad: 'linear-gradient(140deg, #7abedf, #18668c)', hex: '#267eaa' },
  { value: 'bean', label: '豆沙绿', grad: 'linear-gradient(140deg, #a3ddb0, #4fa96a)', hex: '#4fa96a' },
] as const;

/** 字节 → 人类可读（1.2 GB / 320 MB） */
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 运行时长 → 「2 天 3 小时」 */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return `${sec} 秒`;
}

/** 只比 主.次（服务端 1.2 vs 包内 1.2.0 视为一致） */
const majorMinor = (v: string | undefined): string => (v ?? '').split('.').slice(0, 2).join('.');

/**
 * 设置页（方案 §4 P6）：阅读偏好 / 外观 / 存储 / 备份 / 认证 / 关于。
 *
 * 两类设置，归属不同：
 *   - **阅读偏好 + 外观（10 项）**：按设备存，localStorage 唯一真源（useDevicePrefs）。
 *     同一账号在手机/平板/桌面上可以各用各的，改一个不会影响别的设备。
 *   - **系统设置（自动扫描间隔 / 缓存上限）**：服务端执行，PUT 到服务端。
 * 判据：这 10 项的「正确值」由屏幕比例、内存、触控决定，与账号无关——
 * 一台设备改了不该影响另一台，所以放本机。
 */
export default function SettingsPage() {
  const { data: settings, isLoading, isError, error, refetch } = useSettings();
  /** 本机偏好（10 项） */
  const { prefs, setPref } = useDevicePrefs();
  const save = useSaveSettings();
  const scan = useTriggerScan();
  const { data: cache } = useCacheStats();
  const clearCache = useClearCache();
  const evictCache = useEvictCache();
  const { data: about } = useAbout();

  // 登录保护（单账号门禁）
  const navigate = useNavigate();
  const { data: auth } = useAuthStatus();
  const setAuthEnabled = useSetAuthEnabled();
  const setCredentials = useSetCredentials();
  const logout = useLogout();
  const [pwdForm, setPwdForm] = useState(false);
  const [pwdUser, setPwdUser] = useState('');
  const [pwd1, setPwd1] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  /** 保存密码后是否顺手把门禁打开（首次启用走这条） */
  const [enableAfterSave, setEnableAfterSave] = useState(false);
  const isAuthed = !!auth?.authenticated;

  // 数据备份
  const fileRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState<'' | 'export' | 'import'>('');
  const [backupMsg, setBackupMsg] = useState('');

  const onExport = async () => {
    setBackupBusy('export');
    setBackupMsg('');
    try {
      const data = await api.exportBackup();
      // 本机偏好由前端补进文件：它不在服务端（按设备存），备份却是跨设备迁移的
      // 唯一通道，所以必须在这里拼上，否则换设备恢复会丢主题与阅读偏好。
      const payload = { ...data, devicePrefs: devicePrefsSnapshot() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fakenews-comics-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMsg(
        `已导出：进度 ${data.progress.length} 条、收藏 ${data.favorites.length} 条、本机偏好 10 项`,
      );
    } catch (e) {
      setBackupMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy('');
    }
  };

  const onImport = async (file: File) => {
    setBackupBusy('import');
    setBackupMsg('');
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      // devicePrefs 是本机概念：先应用到 localStorage，再从 body 里剥掉，
      // 否则服务端会把它当成一个普通 settings 键写进 settings 表。
      const prefsFromFile = parsed.devicePrefs as Partial<DevicePrefs> | undefined;
      delete parsed.devicePrefs;
      const r = await api.importBackup(parsed);
      if (prefsFromFile) applyDevicePrefs(prefsFromFile);
      setBackupMsg(
        `导入完成：进度 ${r.imported.progress}、收藏 ${r.imported.favorites}、设置 ${r.imported.settings}` +
          (prefsFromFile ? '、本机偏好已应用' : '') +
          (r.skipped > 0 ? `（跳过 ${r.skipped} 条不属于本机的记录）` : ''),
      );
    } catch (e) {
      setBackupMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy('');
    }
  };

  if (isError) {
    return (
      <ErrorState
        title="设置加载失败"
        error={error}
        hint="服务可能正在忙，稍后再试"
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading || !settings) return <Loading label="加载设置…" />;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    save.mutate(
      { [key]: value } as Partial<Settings>,
      // 开关是乐观更新的，成功不必弹；失败必须说，否则用户看到开关停在新位置、
      // 实际服务端没存上（刷新后又跳回去，像一个灵异 bug）
      { onError: (e) => toast.error(`设置未保存：${e instanceof Error ? e.message : '未知错误'}`) },
    );



  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-lg font-bold">设置</h1>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">阅读偏好</h2>
        <div className="card divide-y divide-ink-800">
          <Row label="默认翻页模式" block uniform>
            <Segmented
              fill
              stretch
              value={prefs.readerMode}
              onChange={(v) => setPref('readerMode', v)}
              options={[
                { value: 'webtoon', label: '卷轴' },
                { value: 'single', label: '单页' },
                { value: 'double', label: '双页' },
                { value: 'split', label: '拆分' },
              ]}
            />
          </Row>
          <Row label="阅读方向" hint="日漫右翻 / 欧漫左翻" block uniform>
            <Segmented
              fill
              stretch
              value={prefs.readDir}
              onChange={(v) => setPref('readDir', v)}
              options={[{ value: 'rtl', label: '右翻' }, { value: 'ltr', label: '左翻' }]}
            />
          </Row>
          <Row label="默认画质" block uniform>
            <Segmented
              fill
              stretch
              value={prefs.quality}
              onChange={(v) => setPref('quality', v)}
              options={[
                { value: 'smooth', label: '流畅' },
                { value: 'standard', label: '标准' },
                { value: 'original', label: '原图' },
              ]}
            />
          </Row>
          <Row
            block
            uniform
            label="适应方式"
            hint={prefs.readerMode !== 'single' ? '双页 / 卷轴模式下固定适应方式，仅单页模式可切换' : undefined}
          >
            <Segmented
              fill
              stretch
              value={prefs.fitMode}
              onChange={(v) => setPref('fitMode', v)}
              disabled={prefs.readerMode !== 'single'}
              options={[
                { value: 'width', label: '宽度' },
                { value: 'height', label: '高度' },
                { value: 'contain', label: '完整' },
                { value: 'original', label: '原始' },
              ]}
            />
          </Row>
          {/* 档位（关/1/3/5/8）而不是步进器：全页唯一的数字控件太扎眼，且 0-8 里
              用户真正会用的就这几档；存量中间值由 devicePrefs 吸附（见 PRELOAD_STEPS）。
              block+uniform 与其他分段行同款：窄屏独占一行等分（手机上若保持
              「标签左控件右」，5 个单字按钮缩在右侧是全页唯一的异类——用户实测反馈）；
              ≥sm 桌面控件列固定 13rem 铺满，与弹层、其余分段行左缘同线 */}
          <Row block uniform label="预加载页数" hint="提前解码后续页面，翻页更跟手">
            <Segmented
              fill
              stretch
              value={prefs.preloadCount}
              onChange={(v) => setPref('preloadCount', v)}
              options={[
                { value: 0, label: '关' },
                { value: 1, label: '1' },
                { value: 3, label: '3' },
                { value: 5, label: '5' },
                { value: 8, label: '8' },
              ]}
            />
          </Row>
          <Row label="翻页动画" block uniform>
            <Segmented
              fill
              stretch
              value={prefs.pageAnimation}
              onChange={(v) => setPref('pageAnimation', v)}
              options={[
                { value: 'pan', label: '平移' },
                { value: 'slide', label: '轻移' },
                { value: 'fade', label: '淡入' },
                { value: 'none', label: '无' },
              ]}
            />
          </Row>
          <Row label="双指缩放" hint="阅读器内两指缩放，放大后可拖动查看">
            <Toggle label="双指缩放" on={prefs.pinchZoom} onChange={(v) => setPref('pinchZoom', v)} />
          </Row>
          <Row label="保持常亮">
            <Toggle label="保持常亮" on={prefs.keepScreenOn} onChange={(v) => setPref('keepScreenOn', v)} />
          </Row>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">主题</h2>
        <div className="card divide-y divide-ink-800">
          <Row label="外观" block uniform>
            <Segmented
              fill
              stretch
              value={prefs.theme}
              onChange={(v) => setPref('theme', v)}
              options={[
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
                { value: 'system', label: '跟随' },
              ]}
            />
          </Row>
          <Row
            label="高亮颜色"
            hint={`强调色 · 当前${
              ACCENT_OPTIONS.find((a) => a.value === prefs.accent)?.label ?? '暖橙'
            }`}
          >
            <div className="flex shrink-0 items-center gap-2.5">
              {ACCENT_OPTIONS.map((a) => {
                const on = prefs.accent === a.value;
                return (
                  <button
                    key={a.value}
                    title={a.label}
                    aria-label={`高亮颜色：${a.label}`}
                    aria-pressed={on}
                    onClick={() => setPref('accent', a.value)}
                    className="touch-hit grid h-8 w-8 place-items-center rounded-full transition-transform duration-150 active:scale-90"
                    // 选中环用「卡片底色 + 该色」两层 box-shadow：不依赖 ring-offset 变量，
                    // 深浅主题下都能和卡片贴住，且不会因为父容器背景变化而露出灰边
                    style={
                      on
                        ? { boxShadow: `0 0 0 2px rgb(var(--ink-900)), 0 0 0 4px ${a.hex}` }
                        : undefined
                    }
                  >
                    <span
                      className="grid h-6 w-6 place-items-center rounded-full shadow-soft"
                      style={{ background: a.grad }}
                    >
                      {on && <Check size={13} strokeWidth={3.5} className="text-white" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </Row>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">存储与扫描</h2>
        <div className="card divide-y divide-ink-800">
          <Row
            block
            label="缓存用量"
            hint={cache ? `${cache.files} 个文件 · 上限 ${fmtBytes(cache.limitBytes)}` : '统计中…'}
          >
            <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
              <span className="text-sm tabular-nums text-ink-300">{cache ? fmtBytes(cache.totalBytes) : '—'}</span>
              <button
                className="btn-ghost touch-hit px-2 py-1 text-xs ring-1 ring-ink-800"
                disabled={clearCache.isPending}
                onClick={() =>
                  clearCache.mutate(undefined, {
                    // 以前点了只看到按钮文字变一下：释放了多少、有没有真释放都不知道
                    onSuccess: (r) => toast.success(`已清理，释放 ${fmtBytes(r.freed)}`),
                    onError: (e) => toast.error(`清理失败：${e instanceof Error ? e.message : '未知错误'}`),
                  })
                }
              >
                {clearCache.isPending ? '清理中…' : '清理'}
              </button>
            </div>
          </Row>
          <Row block uniform label="缓存上限" hint="超出后自动淘汰最久未用的缩略图">
            <Segmented
              fill
              stretch
              value={String(settings.thumbnailCacheMB)}
              onChange={(v) => {
                const mb = Number(v);
                // 先等服务端存上新上限再淘汰：两个 mutate 并发发出时，
                // 淘汰接口读到的还是旧上限 → 一个文件都不删，界面却以为已经缩容。
                void save
                  .mutateAsync({ thumbnailCacheMB: mb })
                  .then(() =>
                    evictCache.mutate(undefined, {
                      onSuccess: (r) => {
                        if (r.deleted > 0) toast.success(`已释放 ${fmtBytes(r.freed)}（${r.deleted} 个文件）`);
                      },
                    }),
                  )
                  .catch((e) =>
                    toast.error(`设置未保存：${e instanceof Error ? e.message : '未知错误'}`),
                  );
              }}
              options={[
                { value: '512', label: '512M' },
                { value: '1024', label: '1G' },
                { value: '2048', label: '2G' },
                { value: '4096', label: '4G' },
              ]}
            />
          </Row>
          <Row block uniform label="自动扫描间隔" hint="0 = 仅手动">
            <Segmented
              fill
              stretch
              value={String(settings.autoScanIntervalHours)}
              onChange={(v) => set('autoScanIntervalHours', Number(v))}
              options={[
                { value: '0', label: '手动' },
                { value: '6', label: '6h' },
                { value: '24', label: '24h' },
              ]}
            />
          </Row>
          <Row block label="立即全量扫描" hint="增量比对，只解析新增/变更">
            <button
              className="btn-primary max-sm:w-full"
              disabled={scan.isPending}
              onClick={() => scan.mutate(undefined)}
            >
              {scan.isPending ? '扫描中…' : '开始扫描'}
            </button>
          </Row>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">数据备份</h2>
        <div className="card divide-y divide-ink-800">
          <Row block label="导出阅读数据" hint="进度、分章已读、收藏、设置 → JSON 文件">
            <button
              className="btn-ghost touch-hit px-3 py-1.5 text-xs ring-1 ring-ink-800 max-sm:w-full"
              disabled={backupBusy !== ''}
              onClick={onExport}
            >
              {backupBusy === 'export' ? '导出中…' : '导出'}
            </button>
          </Row>
          <Row block label="导入阅读数据" hint="合并导入，不会删除本地数据；仅匹配本机已有的漫画">
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onImport(f);
                  e.target.value = '';
                }}
              />
              <button
                className="btn-ghost touch-hit px-3 py-1.5 text-xs ring-1 ring-ink-800 max-sm:w-full"
                disabled={backupBusy !== ''}
                onClick={() => fileRef.current?.click()}
              >
                {backupBusy === 'import' ? '导入中…' : '选择文件'}
              </button>
            </div>
          </Row>
          {backupMsg && <p className="px-4 py-2 text-[11px] text-ink-400">{backupMsg}</p>}
        </div>
      </section>

      {/* 登录保护：单账号门禁。默认关闭——升级不打断现有用户；开启后所有页面需登录 */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">登录保护</h2>
        <div className="card divide-y divide-ink-800">
          <Row
            label="启用登录保护"
            hint={
              auth?.enabled
                ? `已开启${isAuthed && auth.username ? ` · 当前用户 ${auth.username}` : ''}`
                : '关闭时局域网内任何人可直接访问'
            }
          >
            <Toggle
              label="启用登录保护"
              on={!!auth?.enabled}
              onChange={(on) => {
                setPwdMsg('');
                if (!on) {
                  setAuthEnabled.mutate(false);
                  return;
                }
                // 没设过密码不能直接开：否则把自己锁在外面
                if (!auth?.hasCredential) {
                  setPwdForm(true);
                  setEnableAfterSave(true);
                  setPwdUser((v) => v || 'admin');
                  return;
                }
                setAuthEnabled.mutate(true);
              }}
            />
          </Row>
          <Row label={auth?.hasCredential ? '修改用户名 / 密码' : '设置用户名 / 密码'} hint="至少 6 位；修改后会踢掉其它设备的登录">
            <button
              className="btn-ghost touch-hit px-3 py-1.5 text-xs ring-1 ring-ink-800"
              onClick={() => {
                setPwdForm((v) => !v);
                setPwdMsg('');
                setEnableAfterSave(false);
                setPwdUser(auth?.username ?? 'admin');
                setPwd1('');
                setPwd2('');
              }}
            >
              {pwdForm ? '收起' : auth?.hasCredential ? '修改' : '设置'}
            </button>
          </Row>
          {pwdForm && (
            <div className="space-y-2 px-4 py-3">
              <input
                className="input"
                placeholder="用户名"
                value={pwdUser}
                onChange={(e) => setPwdUser(e.target.value)}
                autoComplete="username"
              />
              <input
                type="password"
                className="input"
                placeholder="密码（至少 6 位）"
                value={pwd1}
                onChange={(e) => setPwd1(e.target.value)}
                autoComplete="new-password"
              />
              <input
                type="password"
                className="input"
                placeholder="再输一次密码"
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                autoComplete="new-password"
              />
              {pwdMsg && <p className="text-[11px] text-red-400">{pwdMsg}</p>}
              <button
                className="btn-primary w-full py-2 text-sm"
                disabled={setCredentials.isPending || setAuthEnabled.isPending}
                onClick={async () => {
                  setPwdMsg('');
                  if (!pwdUser.trim()) return setPwdMsg('请输入用户名');
                  if (pwd1.length < 6) return setPwdMsg('密码至少 6 位');
                  if (pwd1 !== pwd2) return setPwdMsg('两次输入的密码不一致');
                  try {
                    await setCredentials.mutateAsync({ username: pwdUser.trim(), password: pwd1 });
                    if (enableAfterSave) await setAuthEnabled.mutateAsync(true);
                    setPwdForm(false);
                    setPwd1('');
                    setPwd2('');
                    setEnableAfterSave(false);
                  } catch (e) {
                    setPwdMsg(e instanceof Error ? e.message : '保存失败');
                  }
                }}
              >
                {setCredentials.isPending || setAuthEnabled.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          )}
          {auth?.enabled && (
            <Row label="退出登录" hint="仅影响本浏览器；其它设备的会话仍然有效">
              <button
                className="btn-ghost touch-hit px-3 py-1.5 text-xs ring-1 ring-ink-800"
                disabled={logout.isPending}
                onClick={async () => {
                  await logout.mutateAsync();
                  navigate('/login', { replace: true });
                }}
              >
                {logout.isPending ? '退出中…' : '退出'}
              </button>
            </Row>
          )}
        </div>
      </section>

      {/* 关于：版本 / 运行环境 / 路径。版本不一致是「装了旧包」最直观的信号 */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">关于</h2>
        <div className="card divide-y divide-ink-800">
          <div className="flex items-center gap-3 px-4 py-4">
            <BrandLogo size={44} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {about?.name ?? '肥牛漫画'}
                <span className="ml-1.5 rounded bg-ink-800 px-1.5 py-0.5 text-[11px] font-normal text-accent align-middle">
                  v{about?.version ?? '—'}
                </span>
              </p>
              <p className="text-[11px] text-ink-500">飞牛 NAS 漫画阅读器 · fnOS fpk 应用</p>
            </div>
          </div>
          {/* 后端是 Go（历史遗留字段名 node 里装的是 runtime.Version()，即 go1.x.y），
              显示成「Node go1.x.y」是自相矛盾的，这里按 Go 呈现 */}
          <Row label="运行环境" hint={about ? `Go ${about.node} · ${about.platform}` : '读取中…'}>
            <span className="text-[11px] tabular-nums text-ink-400">
              {about ? `已运行 ${fmtUptime(about.uptimeSec)}` : ''}
            </span>
          </Row>
          <Row label="构建时间" hint={about?.builtAt ? new Date(about.builtAt).toLocaleString() : '未知'}>
            <span className="text-[11px] tabular-nums text-ink-400">{about ? `端口 ${about.port}` : ''}</span>
          </Row>
          <Row label="前端版本" hint={about ? `服务端 v${about.version}` : '读取中…'}>
            <span className="text-[11px] tabular-nums text-ink-400">v{__APP_VERSION__}</span>
          </Row>
          {/* 路径行沿用 Row 的左右布局（与上面几行一致）。
              长路径用 break-words 在必要处折行，右侧状态 shrink-0 + nowrap 不被挤压，
              两者之间有 Row 的 gap-x-4 兜着，不会再出现贴字。 */}
          <Row label="漫画根目录" hint={about?.comicRoot ?? '—'}>
            <span
              className={`shrink-0 whitespace-nowrap text-[11px] ${
                about && !about.dataWritable ? 'text-red-400' : 'text-ink-400'
              }`}
            >
              {about ? (about.dataWritable ? '数据目录可写' : '数据目录不可写') : ''}
            </span>
          </Row>
          <Row label="数据目录" hint={about?.dataDir ?? '—'}>
            <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-400">
              {about ? fmtBytes(about.dbBytes) : ''}
            </span>
          </Row>
          <Row label="数据库文件" hint={about?.dbFile ?? '—'}>
            <span />
          </Row>
          {about && majorMinor(about.version) !== majorMinor(__APP_VERSION__) && (
            <p className="px-4 py-2.5 text-[11px] leading-relaxed text-amber-300">
              ⚠️ 前端 v{__APP_VERSION__} 与服务端 v{about.version} 版本不一致：可能是安装包未完整更新。
              请重新安装 fpk 后强制刷新页面（Ctrl/Cmd + Shift + R）。
            </p>
          )}
        </div>
        <p className="mt-2 px-1 text-[11px] leading-relaxed text-ink-500">
          漫画目录只读扫描，不会修改或删除你的文件；阅读进度、收藏、分类与设置都保存在上面的数据目录里（SQLite），
          换机时可用「数据备份」导出导入。
        </p>
        {/* 设置页的收尾签名：抱书娘站在这里代替一句「感谢使用」。
            与状态页同款 mask 着色，颜色自动跟主题。 */}
        <div className="mt-6 flex flex-col items-center gap-1">
          <Mascot kind="loading" className="h-28 w-28" />
          <p className="text-[11px] tracking-wide text-ink-500">卷卷·Karole</p>
        </div>
      </section>

      <p className="pb-4 text-center text-[11px] text-ink-600">
        肥牛漫画 v{about?.version ?? '—'} · fnOS fpk 应用
      </p>
    </div>
  );
}
