/** @type {import('tailwindcss').Config} */
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
        // 文字层级（跟随主题变量，深浅切换自动生效）
        ink: {
          900: 'var(--ink-900)',   // 大标题 / 大数字
          700: 'var(--ink-700)',   // 卡片标题
          500: 'var(--ink-500)',   // 正文说明
          400: 'var(--ink-400)',   // 辅助小字
          300: '#CBD5E1',
          200: '#E2E8F0',
        },
        up: '#10B981',
        down: '#EF4444',
      },
      borderRadius: {
        card: '20px',
        tile: '12px',
      },
      boxShadow: {
        card: '0 2px 12px rgba(0, 0, 0, 0.04)',
        'card-hover': '0 12px 40px rgba(99, 102, 241, 0.12)',
        soft: '0 4px 16px rgba(99, 102, 241, 0.05)',
        glass: '0 2px 20px rgba(15, 23, 42, 0.04)',
        pop: '0 16px 48px rgba(15, 23, 42, 0.14)',
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
