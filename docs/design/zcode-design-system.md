# ZCode 设计系统（从安装产物提取）

来源：`D:\software\zcode\resources\app\out\renderer\assets\styles-BrdMvRZW.css`（编译后 Tailwind v4 + 设计 token）与 `IntlProvider-CyTmJHD8.js` / `styles-C2WGZ-SY.js`（组件实现）。值为编译产物中的实际值，可直接作为还原依据。

## 1. 基础字体与字号系统

- 字体：`ui-sans-serif, system-ui, sans-serif`；等宽 `ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "PingFang SC"...`
- **基础字号 `--ui-font-size: 14px`**，整套 UI 字阶由它派生：

| Token | 值 | 用途（从组件观察） |
|---|---|---|
| `text-ui-xl` | 18px | 大标题（极少用） |
| `text-ui-lg` | **16px** | 页面/分区标题（如「已安装」「MCP 服务器」） |
| `text-ui-base` | **14px** | 正文、行名称、按钮、搜索输入 |
| `text-ui-caption` | 13px | 次要说明 |
| `text-ui-sm` | **12px** | 行描述、次要文字 |
| `text-ui-xs` | 10px | kv 标签、徽标 |

- 页面大标题（如「文档技能」）：`text-2xl font-semibold tracking-tight`（24px/600/-0.025em）——不是 28px bold。

## 2. 颜色 Token（深色主题，参考截图即此主题）

基于 Tailwind v4 默认 oklch 调色板 + 语义层：

| Token | 值 | 说明 |
|---|---|---|
| `--color-background` | `neutral-900`（#171717） | 页面背景；Windows 变体 `#161616` |
| `--color-sidebar` | `neutral-950`（#0a0a0a） | 侧栏 |
| `--color-panel` / `--color-header` | `neutral-900`（Win: `#202020`） | 面板/标题栏 |
| `--color-card` / `--color-popover` / `--color-input` | `neutral-800`（#262626；Win: `#2b2b2b`） | 卡片/菜单/输入框底 |
| `--color-foreground` | `neutral-200`（#e5e5e5；Win: `neutral-300`） | 主文字 |
| `--color-foreground-subtle` | `neutral-700 60%`（暗色下约 #a3a3a3） | 次要文字（行描述等） |
| `--color-foreground-subtlest` | `neutral-700 40%` | 最弱文字 |
| `--color-border` | `white 10%` | 边框 |
| `--color-border-hover` | `white 15%` | 边框悬停 |
| `--color-surface` | `white 5%` | 微弱填充（分隔线也用它：`h-px bg-surface`） |
| `--color-surface-hover` / `--color-hover` | `white 10%` | 行悬停 |
| `--color-selected` | `white 10%` | 选中（分段胶囊激活底色） |
| `--color-brand` | `sky-500` | 品牌色 |
| `--color-accent` | `sky-950 50%` | 强调底色 |
| `--color-success` / `--color-warning` / `--color-destructive` | `green-600` / `yellow-600` / `red-600` | 状态色 |

要点：**没有阴影 token**（扁平设计，层级靠背景色深浅）；浅色主题同理（背景 neutral-50、前景 neutral-700、卡片纯白、边框 black 10%）。

## 3. 圆角与间距

- 圆角：`rounded-xs/sm/md/lg/xl/2xl/3xl` = 2/4/6/8/**12**/16/24px。UI 里最常用 `rounded-lg`(8) 与 `rounded-xl`(12)；详情页大图标 `rounded-2xl`(16)。
- 间距基准 `--spacing: 0.25rem`；页面区块间用 **`space-y-8`（32px）**。
- 圆点等小图形：`size-1.5`；图标常用 `size-3.5`/`size-4`。

## 4. 组件规格（从实现提取的原始 class）

- **搜索框**：`h-9 rounded-xl`，图标 `size-4` 绝对定位 `left-3`，文字 `text-ui-base`。
- **分段页签（公开/个人）**：`rounded-full px-3 py-1 text-ui-base font-medium`；激活 `bg-selected text-foreground`，未激活 `text-foreground-subtle hover:bg-hover hover:text-foreground`。
- **分区标题**：`text-ui-lg font-semibold` + `pb-2`，分隔线是独立元素 `h-px bg-surface`（不是 border），内容 `mt-2`；带计数时计数以普通文字跟在标题后。
- **列表行（市场条目）**：`flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-hover`；图标 tile `size-10`（圆角 xl）；名称 `text-ui-base font-semibold`；描述 `mt-0.5 truncate text-ui-sm text-foreground-subtle`；行尾菜单触发器 `ghost + icon-md`（MoreVertical `size-4`）。
- **网格**：`grid gap-x-6 gap-y-1 sm:grid-cols-2`；分组“显示更多”按钮 `mt-2 px-2 py-2 text-ui-base text-foreground-subtle hover:bg-hover`。
- **已安装横条**：标题行 `border-b border-border pb-2` + 右侧 `outline icon-lg` 滑杆按钮；图标行 `mt-3 flex items-center gap-3 overflow-x-auto pb-1`，图标按钮 40px `rounded-xl hover:scale-105`。
- **详情页头部**：`space-y-3`（图标 → 名称行 → 描述 三段各隔 12px）；图标 `size-16 rounded-2xl` 内部图标 `size-6`；名称 `text-2xl font-semibold tracking-tight` 与右侧操作 `items-center justify-between gap-3`；主按钮 `variant=default size=lg`、菜单触发 `variant=outline size=icon-lg`；立即试用图标 `size-3.5`。
- **推荐位（hero）**：非图片，是生成的渐变面板——`relative overflow-hidden` 深色底 + 两个 `blur-3xl` 圆形辉光（`cyan-300/22`、`blue-400/18`），标题 `text-slate-50`、描述 `text-slate-200/72`，内嵌示例 prompt 胶囊（按内容分类映射 documents/pdf/spreadsheets 图标）。
- **kv 行**：标签在值上方 `text-ui-xs text-foreground-subtle` + 值 `font-mono text-ui-xs`（hook 等技术明细）；或盒装 `rounded-lg border bg-surface px-3 py-2`（根路径）。
- **能力分区顺序**：`mcp → skill → command → agent → hook`，每区标题带计数。
- **菜单项**：普通项 `text-foreground-subtle`（hover 提升），destructive（卸载）红色；分隔线 `qe`。

## 5. 分类体系（市场）

`productivity 生产力 / developerTools 开发者工具 / utilities 实用工具 / guides 指南 / finance / template / other`——插件 listing 声明 category，市场按此分组展示。

## 6. Lume 对应映射（消费方式）

Lume 侧等价换算（我们的 token → ZCode 观察值）：

| Lume | ZCode |
|---|---|
| `--text-1` | `--color-foreground` |
| `--text-2` / `--text-3` | `--color-foreground-subtle` / `-subtlest` |
| `--surface-2` 行悬停 | `--color-hover`（white 10%） |
| `--border-strong` 细线 | `--color-border`（white 10%） |
| 分区标题 16px | `text-ui-lg`（16px）✅ 一致 |
| 行名称 14px semibold / 描述 12px | `text-ui-base` semibold / `text-ui-sm` subtle ✅ 一致 |

市场/详情两页已按上述值实现；后续新页面对齐时直接引用本表。
