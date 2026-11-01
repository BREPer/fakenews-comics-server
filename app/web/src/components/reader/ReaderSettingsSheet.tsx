import { Row, Segmented, Toggle } from '@/components/ui/settings-controls';
import type { DevicePrefs, FitMode, PageAnimation, Quality, ReaderMode, ReadDir } from '@/types';

/**
 * 阅读设置弹出层：翻页模式 / 方向 / 画质 / 适应 / 预加载 / 双指缩放。
 *
 * 这些项都是**按设备**的偏好（utils/devicePrefs.ts），改完立刻落 localStorage，
 * 不再写服务端——同一账号在平板和手机上可以各用各的。
 */
export function ReaderSettingsSheet({
  prefs,
  onChange,
}: {
  prefs: DevicePrefs;
  onChange: (patch: Partial<DevicePrefs>) => void;
}) {
  return (
    <div className="divide-y divide-ink-800 pb-4">
      <Row label="翻页模式" uniform>
        <Segmented<ReaderMode>
          stretch
          value={prefs.readerMode}
          onChange={(v) => onChange({ readerMode: v })}
          options={[
            { value: 'webtoon', label: '卷轴' },
            { value: 'single', label: '单页' },
            { value: 'double', label: '双页' },
            { value: 'split', label: '拆分双页' },
          ]}
        />
      </Row>
      <Row label="阅读方向" uniform>
        <Segmented<ReadDir>
          stretch
          value={prefs.readDir}
          onChange={(v) => onChange({ readDir: v })}
          options={[{ value: 'rtl', label: '右翻（日漫）' }, { value: 'ltr', label: '左翻（欧漫）' }]}
        />
      </Row>
      <Row label="画质" uniform>
        <Segmented<Quality>
          stretch
          value={prefs.quality}
          onChange={(v) => onChange({ quality: v })}
          options={[
            { value: 'smooth', label: '流畅' },
            { value: 'standard', label: '标准' },
            { value: 'original', label: '原图' },
          ]}
        />
      </Row>
      <Row label="翻页动画" uniform>
        <Segmented<PageAnimation>
          stretch
          value={prefs.pageAnimation}
          onChange={(v) => onChange({ pageAnimation: v })}
          options={[
            { value: 'pan', label: '平移' },
            { value: 'slide', label: '轻移' },
            { value: 'fade', label: '淡入' },
            { value: 'none', label: '无' },
          ]}
        />
      </Row>
      <Row label="适应方式" uniform>
        <Segmented<FitMode>
          stretch
          value={prefs.fitMode}
          onChange={(v) => onChange({ fitMode: v })}
          disabled={prefs.readerMode !== 'single'}
          options={[
            { value: 'width', label: '宽度' },
            { value: 'height', label: '高度' },
            { value: 'contain', label: '完整' },
            { value: 'original', label: '原始' },
          ]}
        />
      </Row>
      {prefs.readerMode !== 'single' && (
        <p className="px-4 pb-3 text-[11px] leading-relaxed text-ink-500">
          {prefs.readerMode === 'webtoon'
            ? '卷轴模式为上下连续滚动，固定按「宽度」适应。'
            : prefs.readerMode === 'split'
              ? '拆分双页把宽幅跨页图（宽大于高）左右对半显示；普通竖版页整页显示。'
              : '双页两图并排，固定按「高度」适应；章节首页与末页单独占一屏。'}
        </p>
      )}
      <Row label="预加载页数" uniform>
        {/* 与设置页同款档位（关/1/3/5/8），见 settings-controls.tsx 顶部的取舍说明 */}
        <Segmented
          stretch
          value={prefs.preloadCount}
          onChange={(v) => onChange({ preloadCount: v })}
          options={[
            { value: 0, label: '关' },
            { value: 1, label: '1' },
            { value: 3, label: '3' },
            { value: 5, label: '5' },
            { value: 8, label: '8' },
          ]}
        />
      </Row>
      <Row label="双指缩放" uniform>
        <Toggle on={prefs.pinchZoom} onChange={(v) => onChange({ pinchZoom: v })} label="双指缩放" />
      </Row>
      <p className="px-4 pt-3 text-[11px] leading-relaxed text-ink-500">
        提示：桌面端方向键 ←/→ 翻页，↑/↓（PageUp/PageDown）同样可翻页；Esc 退出。进度自动记忆，切章/返回不丢失。
        {prefs.pinchZoom && ' 开启双指缩放后：两指缩放，放大状态下单指拖动查看，单击只显隐工具栏。'}
      </p>
    </div>
  );
}
