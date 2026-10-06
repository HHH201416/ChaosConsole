/** @type {import('tailwindcss').Config} */

/**
 * 双主题（深色 / 浅色）色板。
 *
 * 做法：**不**在几百处类名上加 `dark:` 前缀，而是把色板接到 CSS 变量上 ——
 * `bg-ink-900` 这类类名一个字都不用改，切主题只靠 `<html data-theme>` 属性。
 * 变量的两套取值在 `src/index.css` 的 `:root` / `[data-theme='light']` 里。
 *
 * 三条硬约束，改之前先看清楚：
 *
 * 1. **`/ <alpha-value>` 不能丢**。全仓库有 51 处带透明度修饰符的用法
 *    （`bg-sky-500/10`、`border-ink-500/70`、`bg-rose-900/40` …）。写成
 *    `rgb(var(--c-x))` 会让这些全部失效，肉眼是「淡底胶囊全变成实心色块」。
 *
 * 2. **深色取值必须与 Tailwind 内建值逐字节相同**。这些变量接管了内建色板，
 *    值写错一点，深色下就是全局视觉回归。浅色的淡底（`bg-sky-500/10` 这类）
 *    靠 alpha 自己做出来，所以 `-500` 这些实心档在浅色下基本不动。
 *
 * 3. **同一个色档不要同时承担「文字」和「实心背景」两个角色**。这次踩到的：
 *    `slate-500/600/700` 既当正文次要色又当实心圆点（已把那 10 处实心用法改成
 *    `bg-ink-400`）、`boss` 既当填充又当淡底上的文字（拆出 `boss.strong` /
 *    `boss.on` 两个新档）。再加新用法时先想清楚它属于哪个角色。
 *
 * 这里只写「要接变量」的档位。Tailwind 的 `theme.extend` 对嵌套色对象是深合并
 * （node_modules/tailwindcss/lib/util/resolveConfig.js:119-131），没写的档位
 * 继续用内建值。
 */

/** 把色档名接成 CSS 变量。`ink-900` -> `rgb(var(--c-ink-900) / <alpha-value>)` */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

/** 逐档接变量的快捷写法：vScale('slate', [200, 300]) */
const vScale = (family, shades) =>
  Object.fromEntries(shades.map((s) => [s, v(`${family}-${s}`)]))

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
        /* 表面 / 描边 / 文字色阶。深色下 900 最深（画布、内嵌卡片），
           800 是面板，700 是抬起一层；浅色下反过来由亮到暗，但**角色不变**。 */
        ink: vScale('ink', [400, 500, 600, 700, 800, 900]),

        /* slate 在本项目里被当「前景文字色阶」用（深色下 200 是正文），
           借的是 Tailwind 内建名。接上变量后浅色下它会整体翻成深色文字。 */
        slate: vScale('slate', [100, 200, 300, 400, 500, 600, 700]),

        /* 强调色。`-300/-400` 这些是「淡底上的文字」，浅色下要压深才读得出来；
           `-500/-600` 是实心点与按钮底，两个主题下基本不动。 */
        emerald: vScale('emerald', [200, 300, 400, 500, 600, 700, 900, 950]),
        rose: vScale('rose', [200, 300, 400, 500, 600, 700, 900]),
        sky: vScale('sky', [300, 400, 500]),
        violet: vScale('violet', [300, 500, 600]),
        amber: vScale('amber', [50, 200, 300, 400, 500]),
        teal: vScale('teal', [300, 500]),
        lime: vScale('lime', [300, 500]),
        fuchsia: vScale('fuchsia', [300, 500]),
        indigo: vScale('indigo', [300, 500]),
        pink: vScale('pink', [300, 500]),
        orange: vScale('orange', [300, 500]),
        cyan: vScale('cyan', [300, 500]),

        /* 品牌橙。三档分工，别混用：
           - DEFAULT/dark：**填充**（`bg-boss` 圆点、进度条）与描边、淡底。
             两个主题下都保持这个饱和度 —— 它本身就是品牌色。
           - strong：**品牌色淡底上的文字**（`bg-boss/15 text-boss-strong`）。
             浅色下必须压深，否则 #f5a524 压在奶油色上只有 2:1 对比度。
           - on：**实心品牌填充上的文字**（`.btn-primary`）。两个主题下都是深色。 */
        boss: {
          DEFAULT: v('boss'),
          dark: v('boss-dark'),
          strong: v('boss-strong'),
          on: v('boss-on'),
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
