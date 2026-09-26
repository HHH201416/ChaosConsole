/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      // 「侧栏 + 对话面板恢复原始宽度（256 / 480）」的那一档。
      //
      // 取 1560 不是随手定的：那一档面板要多吃 208px，如果阈值定低了，窗口从 1559
      // 变宽到 1560 反而会让每列从 227px 骤降到 176px —— 越宽越挤。定在 1560 之后，
      // 进入这一档时每列恰好还有 191px，也就是原来 1560×940 下的那个宽度，
      // 之后随窗口变宽只增不减。
      //
      // 也不用 2xl(1536)：BrowserWindow 的 width 是含边框的外框宽，1560 的外框只对应
      // 约 1544 的内宽，离 1536 只剩 8px，换个 DPI 或系统边框样式就会掉档。
      screens: {
        desk: '1560px',
      },
      colors: {
        ink: {
          900: '#0b0e14',
          800: '#11151f',
          700: '#161b28',
          600: '#1e2536',
          500: '#2a3346',
          400: '#3a4560',
        },
        boss: {
          DEFAULT: '#f5a524',
          dark: '#c47f13',
        },
      },
      fontFamily: {
        sans: ['"Microsoft YaHei"', '"PingFang SC"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Consolas', '"Cascadia Mono"', 'monospace'],
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.25 },
        },
        slideUp: {
          from: { opacity: 0, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
        slideUp: 'slideUp 0.15s ease-out',
      },
    },
  },
  plugins: [],
}
