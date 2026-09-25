/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
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
