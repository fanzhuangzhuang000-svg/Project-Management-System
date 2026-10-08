import colors from 'tailwindcss/colors'

/** @type {import('tailwindcss').Config} */

/* ==========================================================================
   主题色板：所有「会随深浅主题变的东西」都接到 CSS 变量上（见 src/index.css）
   —— 组件里不要写死 bg-white / bg-slate-50，写成下面这些语义名。

   · 表面层级：surface（卡片/弹窗）→ subtle（次级块）→ subtle-strong（三级块）
               track（进度槽、分隔线）
   · 文字层级：ink-900 … ink-400（已有，本次补齐 600/800 —— 之前这两个类
               在配置里根本不存在，写了等于没写，颜色一直是继承来的）
   · 彩色底：直接沿用 Tailwind 调色板名（bg-red-50 / text-red-600 …），
             但 50/100/200/600/700/800 这几个「当底色和当彩色字」的档位
             已经被接到变量上，深浅自动切换，不用写 dark: 变体。
             ⚠️ 只有下面 TONE_KEYS 里的色调做了映射：red / amber / orange /
                blue / green / emerald / violet / cyan。新用别的色调（如
                yellow-50）请先到 index.css 里补 --c-*-bg/fg 变量，
                否则它不会跟随主题（audit 工具会扫出来）。
   ========================================================================== */
const TONE_KEYS = ['red', 'amber', 'orange', 'blue', 'green', 'emerald', 'violet', 'cyan']

/** 把某个色调的「底色档位」和「彩色字档位」换成 CSS 变量，其余档位保持原样 */
function themedTone (name) {
  const base = colors[name] || {}
  return {
    ...base,
    50: `rgb(var(--c-${name}-bg) / <alpha-value>)`,
    100: `rgb(var(--c-${name}-bg-strong) / <alpha-value>)`,
    200: `rgb(var(--c-${name}-border) / <alpha-value>)`,
    600: `rgb(var(--c-${name}-fg) / <alpha-value>)`,
    700: `rgb(var(--c-${name}-fg-strong) / <alpha-value>)`,
    800: `rgb(var(--c-${name}-fg-strong) / <alpha-value>)`,
    900: `rgb(var(--c-${name}-fg-strong) / <alpha-value>)`,
  }
}
const TONES = Object.fromEntries(TONE_KEYS.map(k => [k, themedTone(k)]))

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌主色：科技蓝 → 靛蓝
        brand: {
          DEFAULT: '#3B82F6',
          from: '#3B82F6',
          to: '#6366F1',
          purple: '#8B5CF6',
          cyan: '#06B6D4',
          green: '#10B981',
          orange: '#F97316',
          red: '#EF4444',
        },
        // 侧边栏深海军蓝
        navy: { from: '#0F172A', to: '#1E293B', soft: '#1E293B' },
        // 页面底色
        canvas: { from: '#F0F4FF', to: '#F8FAFC' },

        /* ---- 语义表面（深浅主题自动切换）---- */
        surface: 'rgb(var(--c-surface) / <alpha-value>)',           // 卡片 / 弹窗 / 下拉 / 输入框
        subtle: 'rgb(var(--c-surface-2) / <alpha-value>)',          // 次级块（原 bg-slate-50）
        'subtle-strong': 'rgb(var(--c-surface-3) / <alpha-value>)', // 三级块 / hover（原 bg-slate-100）
        track: 'rgb(var(--c-track) / <alpha-value>)',               // 进度槽、分隔线（原 bg-slate-200）
        line: 'rgb(var(--c-line) / <alpha-value>)',                 // 描边基色，配 /10~/30 用

        // 文字层级（跟随主题变量，深浅切换自动生效）
        ink: {
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',   // 大标题 / 大数字
          800: 'rgb(var(--c-ink-800) / <alpha-value>)',   // 强调正文
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',   // 卡片标题
          600: 'rgb(var(--c-ink-600) / <alpha-value>)',   // 小标题
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',   // 正文说明
          400: 'rgb(var(--c-ink-400) / <alpha-value>)',   // 辅助小字
          300: 'rgb(var(--c-ink-400) / <alpha-value>)',
          200: 'rgb(var(--c-track) / <alpha-value>)',
        },

        // 状态色
        up: '#10B981',
        down: '#EF4444',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',

        /* ---- 彩色底：50/100/200/600/700/800/900 接变量，其余档位保持 Tailwind 默认 ---- */
        ...TONES,
        // 表面色板：这三个档位在本项目里就是「底」，一并接变量，避免漏改的残留亮块
        slate: {
          ...colors.slate,
          50: 'rgb(var(--c-surface-2) / <alpha-value>)',
          100: 'rgb(var(--c-surface-3) / <alpha-value>)',
          200: 'rgb(var(--c-track) / <alpha-value>)',
        },
      },
      borderRadius: {
        card: '20px',
        tile: '12px',
      },
      boxShadow: {
        // 深色下浅色阴影等于没有阴影，浮层会"贴"不到页面上，所以走变量
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-hover)',
        soft: 'var(--shadow-soft)',
        glass: 'var(--shadow-glass)',
        pop: 'var(--shadow-pop)',
      },
      fontSize: {
        // [size, lineHeight]
        page: ['24px', { lineHeight: '1.3', fontWeight: '700' }],
        hero: ['28px', { lineHeight: '1.25', fontWeight: '700' }],
        cardtitle: ['14px', { lineHeight: '1.4', fontWeight: '600' }],
        metric: ['32px', { lineHeight: '1.15', fontWeight: '800' }],
        body: ['13px', { lineHeight: '1.6' }],
        tiny: ['12px', { lineHeight: '1.5' }],
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0, 0, 0.2, 1)',
      },
      transitionDuration: { DEFAULT: '200ms' },
      keyframes: {
        floatIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '.5', transform: 'scale(1.35)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'float-in': 'floatIn 240ms ease-out both',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
