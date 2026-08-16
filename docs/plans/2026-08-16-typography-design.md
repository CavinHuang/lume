# Lume 排版体系设计（字体/字号/行宽/档位）

- 日期：2026-08-16
- 状态：设计已确认（三节均经用户逐节确认）
- 分支：worktree-typography-system

## 背景与现状

颜色体系高度集中（index.css 单文件 60+ CSS 变量、10 套主题色板、OKLCH），排版体系完全散落：

- **字体族**：全局仅 `'Geist Variable', sans-serif`，中文无显式声明回落系统；Inter 拉丁 400-700 四权重导入但全库零引用（死代码）
- **字号**：无任何 token，约 1700 处 hardcode utility；事实三档 `text-[12px]`(498)/`text-[13px]`(367)/`text-[11px]`(234)
- **对话流**：消息正文 15px/`max-w-[920px]` vs composer 14px/`max-w-[980px]`，同屏不对齐；正文段落无限宽（约 61 汉字/行，过宽）
- **等宽栈三份不一致**：Tailwind 默认 `--font-mono`、index.css:183、pierre-theme.ts:25（shadow DOM 注入）
- **阅读页**：衬线栈在 ReadingView 组件内联定义，正文仅 12.5px
- **右面板/悬浮岛**：9-12px 微字号自成体系（含 8.5px 半档），无 token
- **用户设置**：外观设置只有主题色/模式，无字号档位
- **packages/ui**：零排版 token，字号各自写死

## 已确认决策

| 决策点 | 结论 |
|---|---|
| 范围 | 对话流体验 + 全局一致性 + 阅读页 + 用户字号档位（全四项） |
| 中文字体 | 打包 **MiSans 可变字体**（免费商用，VF 250-900） |
| 档位作用域 | 只作用于对话流（消息/气泡/composer/markdown/代码块），UI 骨架固定密度 |
| 实施路径 | 方案 A：基建先行、渐进收口；存量 hardcode 语义收敛、不做机械全量替换 |

## 1. 字体族体系

| 族 | 决策 | 字体栈 |
|---|---|---|
| Sans（UI+正文） | Geist 管拉丁/数字，MiSans VF 接管 CJK | `'Geist Variable', 'MiSans Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif` |
| Mono（代码/指标） | 打包 JetBrains Mono VF（@fontsource-variable，纯拉丁 ~200KB） | `'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` |
| Serif（阅读页） | 不打包，优化系统衬线栈 | `Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', STSong, SimSun, serif` |

混排原理：字体栈按序回落，Geist 无汉字字形自然落 MiSans；零 JS 成本。

### 1.1 MiSans 获取与加载

```
apps/web/public/fonts/MiSans-VF.woff2       (~8-9MB 全字符集单文件)
apps/web/public/fonts/MiSans-LICENSE.txt
```

- `@font-face { font-family: 'MiSans Variable'; font-weight: 250 900; font-display: swap; }`
- 不做 unicode-range 分片：本地 file:// 加载毫秒级，swap 保证首帧系统字体渲染
- ponytail: 全量 8-9MB；体积敏感时可子集化常用 7000 字到 ~3MB
- JetBrains Mono 走 `@fontsource-variable/jetbrains-mono`；Geist 已有
- 删除 Inter 四个死权重导入

### 1.2 等宽栈统一（三份 → 一份）

- `@theme` 定义 `--font-mono` 单一来源
- index.css:183 手写栈 → `var(--font-mono)`
- pierre-theme.ts → `var(--font-mono, ui-monospace, ...)`；CSS 自定义属性穿透 shadow boundary 继承，无需 JS 传值
- 全库 106 处 `font-mono` utility 自动生效

### 1.3 阅读页衬线不打包的理由

衬线 CJK 全量 20MB+ 且阅读页低频；系统衬线质量足够。ponytail: 用户反馈差再议 LXGW 文楷等。

## 2. 字号 token + 对话流体验

### 2.1 语义化字号 token

```css
@theme {
  --text-micro:     10px;   /* badge、悬浮岛指标 */
  --text-caption:   11px;   /* 辅助说明、时间戳 */
  --text-secondary: 12px;   /* 右面板正文、次要信息 */
  --text-body:      13px;   /* UI 正文、表单、按钮 */
  --text-body-lg:   14px;   /* 强调正文 */
}
@theme inline {
  --text-chat: var(--lume-chat-font-size);
  --text-chat--line-height: 1.85;
}
```

值 = 现状事实三档收口，视觉零变化、语义有归依。新代码用语义 token，存量不强改。

### 2.2 对话流体验

| 项 | 现状 | 设计 | 理由 |
|---|---|---|---|
| 正文行宽 | 容器 920px、段落无限宽 ≈61 字/行 | 文本块（p/ul/ol/blockquote）限 `--lume-chat-measure: 680px` ≈45 字/行；代码/表格/图片撑满 920px | 中文舒适 35-45 字/行；正文限宽+代码全宽层次 |
| composer 对齐 | 980px / 14px | 920px / 15px，行高同正文 | 消除同屏两套宽度字号 |
| Markdown 标题 | 24/21/18/16px，letter-spacing -0.018em | 1.35em/1.17em/1.07em/1em，letter-spacing 0 | CJK 负字距有害（标点挤压）；em 化联动档位 |
| 代码块字号 | 固定 13px | 0.8667em（=13/15） | 档位联动 |
| 正文/用户消息/行内 code | 15px/1.85/0.88em/weight 450 | 保持，仅字体栈换新 | 现值已对 |

### 2.3 档位联动机制

```css
:root    { --lume-chat-font-size: 15px; }
:root[data-chat-font-scale='sm'] { --lume-chat-font-size: 14px; }
:root[data-chat-font-scale='lg'] { --lume-chat-font-size: 16.5px; }
```

- 核心技巧：对话流内排版值全部相对量化（em/无单位行高），档位切换只改一个变量、经 CSS 继承传导整棵子树
- 作用域：消息正文、用户气泡、composer、markdown 派生（标题/行内 code/代码块）
- 持久化复用 theme-mode.ts 模式：localStorage `lume:chatFontScale`，默认 `md`
- UI：AppearanceSettings 三档 segmented（小 Aa/中 Aa/大 Aa）

## 3. 清理范围 + 阅读页 + 验证

### 3.1 做/不做

做（外科手术 5 处）：
1. 删 Inter 死权重导入
2. index.css 两处手写 mono 栈 → `var(--font-mono)`
3. pierre-theme.ts → `var(--font-mono, ...)`
4. `--reading-serif` 从 ReadingView 内联移入 index.css `:root`
5. CLAUDE.md 加规约：新代码字号用语义 token，禁新增 `text-[Npx]`

不做（有意保留）：
- 存量 ~1700 处 hardcode 不机械替换（语义收敛策略：触碰时顺手迁移，自然代谢）
- 悬浮岛（独立 BrowserView）本次不动，微字号是刻意信息密度设计
- 不建 lint 强制

### 3.2 阅读页重设计

| 项 | 现状 | 设计 |
|---|---|---|
| 衬线栈 | 组件内联 | 移入 `:root`，Georgia 前置 |
| 正文 | 12.5px / 1.75 | 跟随档位变量（中档 15px）/ 1.9 |
| 行宽 | 无限宽 | ~40 汉字/行（max-w-[600px] 量级） |
| 标题 | 16/15/14/13px | em 相对化（1.3/1.17/1.07/1em） |
| 行内 code | 11.5px | 0.85em |

笔记区（note-markdown）同规则联动。

### 3.3 验证

- 自动化：bun:test 现有组件测试全绿；typecheck + lint + build 三关
- 人工验收矩阵：亮/暗 × 三档位 × 四区域（对话流/右面板/设置/阅读页）；重点：MiSans 热替换后标点、中英混排、代码块等宽对齐
- 合规：MiSans 许可证文本入库
- 不新建视觉快照设施

### 3.4 阶段划分

```
Phase 1 排版基建    字体入库 + @theme token + mono 统一 + Inter 删除 + 档位变量/存储（无 UI）
Phase 2 对话流体验  measure 限宽 + 标题 em 化 + composer 对齐 + 代码块 em + 档位接线
Phase 3 档位 UI + 阅读页  AppearanceSettings 三档 + ReadingView 重排
Phase 4 清理收尾    CLAUDE.md 规约 + 顺手迁移
```

交付：worktree 新分支，单 PR、4-6 个主题 commit，经 review 合入 main。
