/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /**
         * 品牌色（高亮色）：走 CSS 变量，默认暖橙，可被设置里的「高亮颜色」换成蓝/灰。
         * 变量定义在 index.css 的 :root（橙）与 :root[data-accent]（蓝/灰）。
         * 之所以不写死 hex：brand-* 类名散落在几十个组件里，改主题色只能靠变量重映射，
         * 否则每换一次色都得全仓替换。
         */
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
        },
        /**
         * 「品牌色当文字/小图标用」的那一档（`text-accent`）：浅色 brand-600、深色 brand-400。
         * 变量在 index.css 的 --accent-text，与 Android 的 theme.accentTextColor() 同义。
         * 别拿它做底色 —— 大面积用 brand-500/600。
         */
        accent: 'rgb(var(--accent-text) / <alpha-value>)',
        /**
         * 收藏色（胭脂红）：固定语义色，**不跟高亮色走**。
         * 收藏是「内容状态」而不是「主题强调」，换高亮色时爱心不该变色。
         * 色值 #9D2933 = 胭脂红（Chinese Color Atlas 的「胭脂」，
         * 与 Wikipedia 的 Japanese Carmine / 臙脂色 同值，两处独立来源一致；
         * 另见的 #E6005C 属偏洋红的「胭脂紅」，与胭脂红釉的沉红语义不符，未采用）。
         * 深色主题下同色相提亮一档（--fav-500），否则深底上偏暗。
         */
        fav: {
          500: 'rgb(var(--fav-500) / <alpha-value>)',
        },
        // 中性色阶走 CSS 变量（index.css 里 :root=浅色 / .dark=深色），
        // 这样 bg-ink-900 / text-ink-100 等既有类名会自动跟随主题切换
        ink: {
          50: 'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          950: 'rgb(var(--ink-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
      /**
       * 统一动效语言：
       *   out-quint —— 界面位移/透明度（起步快、收尾稳，观感最「跟手」）
       *   spring    —— 弹层/徽标（轻微过冲，给「弹出来」的物理感）
       *   in-out-soft —— 需要双向平滑的属性（进度条宽度等）
       * 之前缓动字面量散落在各组件里，改一处要翻到底；统一 token 后整体节奏才一致。
       */
      transitionTimingFunction: {
        'out-quint': 'cubic-bezier(0.22, 1, 0.36, 1)',
        spring: 'cubic-bezier(0.34, 1.42, 0.64, 1)',
        'in-out-soft': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      /**
       * 阴影只留三层：静置「薄」、悬停「厚」、浮层「面板」。
       * 深色界面要更黑 + 更大扩散才看得见，浅色要更淡；取值放在 CSS 变量里按主题切换。
       */
      boxShadow: {
        soft: 'var(--shadow-soft)',
        lift: 'var(--shadow-lift)',
        panel: 'var(--shadow-panel)',
      },
      keyframes: {
        // 通用入场：淡入 + 上浮（路由切换、列表逐项）
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // 弹层/徽标：淡入 + 轻微放大过冲
        pop: {
          from: { opacity: '0', transform: 'scale(0.94)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        rise: 'rise 0.34s cubic-bezier(0.22, 1, 0.36, 1) both',
        pop: 'pop 0.22s cubic-bezier(0.34, 1.42, 0.64, 1) both',
      },
    },
  },
  plugins: [],
};
