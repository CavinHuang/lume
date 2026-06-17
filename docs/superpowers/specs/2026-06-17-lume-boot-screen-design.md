# Lume 启动页（Boot Screen）设计

- **日期**：2026-06-17
- **状态**：待评审
- **范围**：Lume 桌面应用（Tauri + React/Vite 前端）启动期间的过渡启动页
- **参考实现**：`examples/lume_bootscreen_impl/`（复用其结构与动画语言，更换配色与 logo）

---

## 1. 背景与问题

Lume 启动时，从窗口出现到主界面就绪，存在最多 3 段空白：

1. **原生窗口闪白**：Tauri 主窗口创建（`apps/desktop/src-tauri/tauri.conf.json`，单窗口 1640×960，`theme: Light`）到 webview 首次绘制之间。
2. **React 挂载前**：`apps/web/src/main.tsx` 的 `bootstrap()` 在挂载 React 前会同步读主题、做一次 `getGeneralSettings()` IPC。
3. **healthcheck 等待（最长 ~10s）**：`apps/web/src/App.tsx` 用 `withTimeout(healthcheck(), 10_000)` 等待 sidecar 就绪，期间 `if (!ready) return null` —— **整屏空白**。这是空白的主要来源。

当前 `apps/web/index.html` 的 `#root` 为空，启动期间没有任何过渡。

## 2. 目标 / 非目标

**目标**

- 从窗口出现即显示与 Lume 应用视觉一致的启动页，消除可见空白。
- 复用应用现有设计 token（`--brand` / `--surface` / `--background` 等），紫→品红品牌色，跟随浅色/深色主题。
- 提供有「陪伴感」的四阶段动画过渡，healthcheck 通过后有清晰的「就绪」节拍再进入主界面。
- 浅色/深色主题均不闪屏。

**非目标**

- 不实现 Tauri 原生 splash 窗口（覆盖范围方案 B 已排除）。
- 不在本期把阶段绑定到 sidecar 真实启动状态（保留受控接口供未来扩展，见 §7）。
- 不引入额外动画库；沿用参考实现的纯 CSS keyframe 方案。

## 3. 已锁定决策

| 维度 | 决策 |
|---|---|
| 覆盖范围 | **B** — `index.html` 内置静态启动层（窗口一开即绘制）+ React 挂载后无缝接管 + healthcheck 通过后消失 |
| Logo | `apps/web/src/assets/imgs/logo.png`（web 应用主 logo） |
| 配色 | 复用应用 token：紫 `--brand`（`oklch(0.67 0.2 282)` 浅 / `oklch(0.72 0.19 283)` 深）→ 品红 `--brand-2`（`oklch(0.73 0.18 294)` 浅 / `oklch(0.78 0.17 295)` 深），中性底，跟随主题 |
| 动效 | **完整四阶段**：唤醒→整理→记忆→就绪；改紫色；时间驱动 + ready 即跳就绪 |

## 4. 架构与无缝交接（方案 1）

启动页由**两个渲染源**先后绘制同一视觉：

1. **静态层**：写在 `apps/web/index.html` 内的 `#boot-root`，纯 HTML + 内联 CSS。CSS bundle 加载前就要绘制，**不能依赖应用 token**，因此使用由 token 推导的兜底色（见 §8）。首帧即为「唤醒」阶段的完整外观（logo + 底色渐变 + 紫色光晕 + 呼吸动画）。
2. **React 层**：`<LumeBootScreen>` 组件，挂载到 `#root`，使用应用完整 token 体系，驱动四阶段序列。从「唤醒」继续。

**交接**：React 层与静态层在「唤醒」首帧像素对齐。`<LumeBootScreen>` 在首次提交后（`useLayoutEffect` + 双 `requestAnimationFrame` 确保已绘制）移除/隐藏 `#boot-root`。由于两者此刻视觉一致，切换不可见。

> 兜底色与 token 值由同一来源推导（§8），把单帧色差风险压到最低。

被排除的备选：方案 2（静态层无动画、React 接管再上动效，挂载前是死画面）、方案 3（body 只铺底色、logo 由 React 弹入）。

## 5. 主题不闪屏（no-flash）

`apps/web/index.html` 的 `<head>` 内联一段极小脚本，复用 `apps/web/src/lib/theme-mode.ts` 的解析逻辑：

- 读 `localStorage['lume:theme-mode']`（key: `lume:theme-mode`，值 `light|dark|system`），回退到默认；
- 结合 `window.matchMedia('(prefers-color-scheme: dark)')`；
- 规则与 `resolveShouldUseDark(themeMode, prefersDark)` 一致：`themeMode === 'dark' || (themeMode === 'system' && prefersDark)`；
- 在首次绘制前给 `document.documentElement` 切换 `.dark` 类。

这样静态层与后续 React 层都从正确主题开始，浅/深均不闪。React 挂载后由现有 `initThemeModeRuntime` / `setThemeMode` 接管，行为不变。

## 6. 四阶段序列

### 6.1 阶段与场景动画

场景动画沿用参考实现 `examples/lume_bootscreen_impl/`，**配色全部改紫→品红**（光晕、流动卡片、记忆环、漂浮光点、就绪环均使用 `var(--brand)` / `var(--brand-2)` 及其低透明度变体）。

| 阶段 | 时长 | 场景 | 状态文案 |
|---|---|---|---|
| **唤醒** `awaken` | ~1800ms | 呼吸 logo + 紫色光晕由暗渐亮 | 正在唤醒 |
| **整理** `organize` | ~3000ms | 4 张流动卡片向中心汇聚（工作现场归位） | 正在整理 |
| **记忆** `memory` | 循环（直到 ready/超时） | 同心记忆环 + 漂浮光点（记忆重连）；作为「等待 resting」态 | 正在连接记忆 |
| **就绪** `ready` | ~500ms（仅 ready 后） | 就绪环脉冲 + 光晕达到最亮 | 准备好了 |

### 6.2 驱动模型

- 唤醒 → 整理 → 记忆：按计时推进；记忆态循环其动画，作为等待 resting。
- `<LumeBootScreen ready={ready}>` 监听 `ready`：一旦为 `true`，**立即跳转到「就绪」**（无论当前处于哪个阶段）。
- 就绪帧停留 ~400–600ms → 300ms 淡出 → 调用 `onExited` → 卸载 → 主界面渲染。
- healthcheck 超时（10s）→ 不进入「就绪」，由 `App.tsx` 现有错误分支接管。

> 注：当前启动只有一个 `healthcheck` 信号，无分阶段状态。因此「唤醒/整理/记忆」在本质上是装饰性的时间过渡；本期采用时间驱动。组件保留受控接口，未来可改为状态驱动（§7）。

### 6.3 文案

- `title` / `subtitle`：沿用参考实现的用户向文案（如「正在唤醒 Lume」/「像轻轻睁开眼睛一样…」），仅做必要润色。
- `hint`（底部小字）：参考实现中的 hint 多为设计备注（如「这是最符合产品定位的一组动画语言」），**不直接使用**。改为：**默认隐藏；仅当等待 > 5s 时显示**一句温和提示：「首次启动或本地数据较多时，可能需要多等几秒。」

## 7. 退出 / 错误 / 前瞻

- **退出**：ready → 就绪帧（~500ms）→ 淡出（300ms）→ 卸载。
- **错误**：保留 `App.tsx` 现有 healthcheck 超时/失败的错误屏（优先级高于启动页）。
- **前瞻（不在本期实现）**：组件保留参考实现的受控模式 props（`scene` / `autoPlay` / `onSequenceEnd` 等）与 `bootSceneMap` 思路。未来 sidecar 若暴露真实启动阶段，可改为状态驱动而无需重写组件。

## 8. 视觉规格

### 8.1 React 层（使用应用 token，运行时解析）

- 底色：复用 `LumeWelcomeSurface` 的渐变思路 —— `linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 88%, var(--background)) 0%, var(--background) 30%, color-mix(in oklab, var(--surface-2) 54%, var(--background)) 100%)`。
- 品牌光晕：顶部 `radial-gradient` 叠加 `var(--brand)` ~9% + `var(--brand-2)` ~7%（与欢迎页一致的低透明度）。
- 文字：`var(--text-1)` / `var(--text-2)` / `var(--text-3)`。
- 场景元素（卡片/环/光点）：`var(--brand)` / `var(--brand-2)`，按元素调透明度。

### 8.2 静态层兜底色（token 推导值）

| | 浅色 | 深色 |
|---|---|---|
| 底色渐变 | `#fafbfd → #ffffff → #f3f4f8` | `#202024 → #1a1a1d → #242428` |
| 品牌光晕 | `rgba(139,92,246,.13)` / `rgba(192,38,211,.06)` | `rgba(167,139,250,.16)` / `rgba(217,70,190,.09)` |
| 状态文字 | `#6a6a78` | `#9b9ba8` |
| 紫 / 品红基准 | `#8b5cf6` / `#c026d3` | `#a78bfa` / `#e879c7` |

### 8.3 配色映射（参考 → Lume）

| 参考实现（sage） | Lume |
|---|---|
| 底 `#11120f`（暖近黑） | `var(--background)` + surface 渐变（跟随主题） |
| 强调 `rgba(147,167,123,…)`（鼠尾草绿） | `var(--brand)` / `var(--brand-2)`（紫→品红） |
| 文字 `rgba(245,243,235,.94)`（暖白） | `var(--text-1/2/3)`（跟随主题） |

## 9. 文件结构与集成点

- **`apps/web/index.html`**
  - `<head>` 增加内联 no-flash 主题脚本（§5）。
  - `<head>` 增加内联 `<style>` 的静态 boot CSS（使用 §8.2 兜底色，无额外请求依赖）。
  - `<body>` 增加 `#boot-root` 静态启动层（HTML）。
- **`apps/web/src/components/boot/LumeBootScreen.tsx`**（新增）
  - 基于参考 `react/LumeBootScreen.tsx` 改造：驱动逻辑改为「时间推进 + 受 `ready` 控制 + ready 即跳就绪 + 淡出」；配色 token 化（§8.1）；保留受控模式 props（§7）。
  - 挂载后移除静态 `#boot-root`（§4 交接）。
- **`apps/web/src/components/boot/lume-boot-screen.css`**（新增）
  - 基于参考 `react/lume-boot-screen.css` 改造：sage → 紫/品红（§8.3），保留动画 keyframes，响应 `.dark`。
- **`apps/web/src/App.tsx`**（修改）
  - `if (!ready) return null` → 渲染 `<LumeBootScreen>`，受 `ready` 控制；引入 `bootDone` 状态：在 boot 的就绪帧 + 淡出完成（`onExited`）后才渲染 `AppInner`，保证过渡完整。
  - `error` 分支保留并优先级最高。
- **Logo**：
  - React 层：`import logoUrl from '@/assets/imgs/logo.png'`（与现有 `VersionUpdateSettings` 用法一致）。
  - 静态层：将 `logo.png` 拷贝到新建的 `apps/web/public/boot-logo.png`，index.html 以 `/boot-logo.png` 引用（Vite 直接按原样提供 `public/`，bundle 加载前即可用）。两处指向同一张源图。

## 10. 验收标准

- [ ] 从窗口出现即显示与 Lume 视觉一致的启动页，**无白屏**（静态层覆盖原生闪白 + React 挂载前 + healthcheck 等待）。
- [ ] 四阶段动画在等待期间流畅播放、配色为紫→品红、**跟随浅/深主题**。
- [ ] `ready` 后约 500ms 就绪帧 + 300ms 淡出进入主界面，**无可见跳变**。
- [ ] 浅色与深色主题**均不闪屏**（no-flash 脚本在首绘前应用 `.dark`）。
- [ ] 静态层 → React 层交接**无双图/闪烁**。
- [ ] healthcheck 超时/失败仍显示**现有错误屏**。
- [ ] 等待 > 5s 时显示温和提示 hint；正常启动不显示。
- [ ] `typecheck` 通过；不引入运行时动画依赖。
