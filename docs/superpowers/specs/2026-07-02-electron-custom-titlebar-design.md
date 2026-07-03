# Electron 自定义窗口控制栏设计

- **日期**：2026-07-02
- **状态**：待实现
- **分支**：codex/electron-final-cutover

## 背景与现状

当前 Lume 桌面端窗口控制栏实现不完整：

- **主进程** `apps/desktop/src/main.ts:308` `createMainWindow`：`titleBarStyle: darwin ? 'hiddenInset' : 'default'`。macOS 已隐藏标题栏（保留原生交通灯），但 **Windows/Linux 仍是完整原生标题栏**，与应用深色主题（`backgroundColor: '#111827'`）割裂。
- **渲染层** `apps/web/src/components/app-shell/TitleBar.tsx`：仅是一个 `fixed h-[50px] pointer-events-none` 的透明覆盖层；macOS 顶部 20px 拖拽区，右侧仅在 active agent thread 时显示 `RightPanelWindowControls`。**没有最小化/最大化/关闭按钮、应用标识**。
- **窗口桥接** `apps/desktop/src/preload.ts` `createWindowBridge`：`startDragging()` 是 no-op；**没有** minimize/maximize/close/isMaximized 等窗口控制 API，也未在 IPC 白名单中。

## 目标

1. **视觉一致性**：Windows/Linux 去掉原生标题栏，改为与应用深色主题融合的无边框标题栏。
2. **功能扩展**：标题栏承载三类内容——应用标识（Logo + Lume）、搜索/命令入口（居中弹性）、左侧栏展开/收起按钮。
3. **跨平台**：macOS 保留原生交通灯（符合 Mac 习惯），Windows/Linux 用纯 HTML 自定义按钮。

## 非目标（YAGNI）

- 不替换 macOS 原生交通灯。
- 不做亮色主题适配（当前应用仅深色）。
- 不主动支持 Win11 Snap Layouts hover 菜单。
- 不用 CSS 模拟 Linux 窗口圆角/阴影。
- 不改动 `wereadWindow`（保持原生）。

## 决策记录

| 决策点 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 平台策略 | 全自定义 / Win自定义+Mac原生 / 分阶段 | Win/Linux 自定义 + macOS 原生交通灯 | Mac 用户习惯红黄绿；VS Code/Slack/Figma 主流做法 |
| 技术路线 | 纯 HTML / titleBarOverlay 原生按钮 | 纯 HTML 完全自定义 | 视觉 100% 可控，能承载自定义内容（功能扩展诉求） |
| frame 配置 | `frame:false` / `titleBarStyle:'hidden'` | `titleBarStyle:'hidden'` | 保留原生窗口边框、阴影、resize 命中区，仅需自绘标题栏内容 |
| IPC 契约 | 通用 invoke 白名单 / 专用 window bridge | 扩展 window bridge（方案 A） | 语义内聚，与现有 `window.startDragging` 同位，不污染业务命令表 |
| 失焦态来源 | 主进程推送 / 渲染层事件 | 渲染层 `blur`/`focus` 事件 | 省一次 IPC 往返，窗口失焦时主进程推送本身不可靠 |

## 设计

### 1. 窗口配置与 IPC 契约

#### 1.1 主进程窗口配置

`apps/desktop/src/main.ts:308` `createMainWindow`，仅改 `mainWindow`（`wereadWindow` 保持不变）：

```ts
titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
// 不设 frame:false。'hidden' 仅去标题栏，保留原生边框、阴影、resize 命中区。
```

macOS 零改动（已是 `hiddenInset`）。

#### 1.2 IPC 契约（方案 A）—— 主进程 / preload 同步

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main.ts` | 新增 `ipcMain.handle('lume:window-control', ...)` 分发 `minimize` / `toggleMaximize` / `close` / `isMaximized`；在 `createMainWindow` 监听 `maximize` / `unmaximize` 事件，经 `emitRendererEvent('window-state', { maximized })` 推送 |
| `apps/desktop/src/preload.ts` | `createWindowBridge()` 扩展 `minimize()` / `toggleMaximize()` / `close()` / `isMaximized()`（走 `ipcRenderer.invoke('lume:window-control', op)`）+ `onMaximizeStateChange(listener)`（订阅 `lume:event:window-state`） |
| 安全 | `lume:window-control` 复用现有 `validateIpcSender(event, mainWindow)`；事件通道 `window-state` 加入 `ALLOWED_RENDERER_EVENT_CHANNELS` 白名单 |

窗口控制只对主窗口的 sender 开放，沿用现有 IPC sender 校验，不引入新的信任面。

#### 1.3 渲染层三层封装同步

| 层 | 文件 | 改动 |
|---|---|---|
| 类型契约 | `apps/web/src/lib/desktop-runtime/bridge.ts:39` `DesktopBridgeWindow` | 加 `minimize?` / `toggleMaximize?` / `close?` / `isMaximized?` / `onMaximizeStateChange?` |
| 渲染层封装 | `apps/web/src/lib/desktop-runtime/window.ts` `getCurrentWindow()` | 返回值补这五个方法，转发到 `bridge.window.*` |
| 消费 | `apps/web/src/components/app-shell/TitleBar.tsx` → 新 `WindowButtons.tsx` | 调 `getCurrentWindow().minimize()` 等 |

### 2. TitleBar 结构与布局

#### 2.1 平台抽象

`apps/web/src/lib/platform.ts` 新增判断，并修正现有过时注释（当前注释称"Windows/Linux 有原生标题栏"，改造后不再成立）：

```ts
export const isCustomWindowControlsPlatform =
  isDesktopRuntime() && !isMacosDesktopShell   // Win/Linux 桌面端需自绘按钮
```

#### 2.2 实体栏布局

`TitleBar.tsx` 从透明覆盖层改为占据空间的实体栏（高度 `h-10` = 40px）：

```
┌─ TitleBar (h-10, app-region: drag) ────────────────────────────┐
│ macOS: [pad 80px] [≡] ◆Lume        🔍 搜索…        [右面板]    │
│ Win:                [≡] ◆Lume        🔍 搜索…   [右面板] [─][□][✕]│
└────────────────────────────────────────────────────────────────┘
┌─ 内容区 (flex-1, min-h-0) ─────────────────────────────────────┐
│ [LeftSidebar]   [MainArea]   [RightPanelWorkspace]              │
└────────────────────────────────────────────────────────────────┘
```

- **左段**：`<SidebarToggle>`（接现有 `sidebarCollapsedAtom`）+ `<Logo>` + "Lume"。macOS `padding-left: 80px` 让位交通灯（交通灯宽约 70px + 边距，实现时微调）。
- **中段**：搜索框 `flex-1`，点击触发现有 `commandPaletteOpenAtom`（Ctrl+K 入口复用）。`app-region: no-drag`。
- **右段**：复用现有 `<RightPanelWindowControls />`（保留"仅 active thread 显示"条件）+ `isCustomWindowControlsPlatform` 时渲染新 `<WindowButtons />`。

#### 2.3 AppShell 结构改动

`apps/web/src/components/app-shell/AppShell.tsx` 根容器从 `flex`（横向 + TitleBar fixed 脱流）改为 `flex flex-col`：

- 第一行：实体 `<TitleBar />`
- 第二行：`flex-1 flex min-h-0` 的横向内容区（LeftSidebar / MainArea / RightPanelWorkspace）
- 移除现有 `pt-5` / `pt-0`（标题栏已实体占据顶部；macOS 交通灯在标题栏内、由左 padding 让位，内容区不再需要顶部留白）

#### 2.4 视觉 token 复用

`WindowButtons` 沿用 `RightPanelWindowControls` 的设计语言：`size-8 rounded-[8px] text-foreground/55 hover:bg-foreground/[0.06]` + lucide 图标（`Minus` / `Square` / `X`，最大化态切 `Copy`），保证与应用深色主题一致。

### 3. 交互行为

#### 3.1 拖拽区

| 区域 | `app-region` |
|---|---|
| 标题栏空白、Logo、左右内边距 | `drag` |
| 搜索框、SidebarToggle、RightPanelWindowControls、WindowButtons | `no-drag` |
| 搜索框两侧留白 | `drag`（让中间区域仍可拖窗，VS Code 做法） |

`preload.ts` 现有 `startDragging()` no-op 保留不动（向后兼容）；新窗口控制一律走 `ipcRenderer.invoke('lume:window-control', op)`。

#### 3.2 双击最大化

Win/Linux 的 `app-region: drag` 区域不会自动双击最大化（macOS 交通灯区原生支持），需在标题栏 drag 区绑定 `onDoubleClick={() => toggleMaximize()}`。按钮区（no-drag）不绑定，避免误触。

#### 3.3 按钮状态

`<WindowButtons />` 内 `useEffect` 订阅 `onMaximizeStateChange`，维护 `maximized` 态驱动图标切换（`Square` ↔ `Copy`）。min / toggleMax / close 分别调 `minimize()` / `toggleMaximize()` / `close()`。

#### 3.4 失焦态

用渲染层 `window.addEventListener('blur' / 'focus')` 直接监听，失焦时按钮组 `text-foreground/30`。不经 IPC（窗口失焦时主进程到渲染层的推送本身不可靠）。

## 改动清单

**主进程 / preload（`apps/desktop`）**

- `src/main.ts`：`createMainWindow` 的 `titleBarStyle`；新增 `lume:window-control` handler 与 `window-state` 事件推送
- `src/preload.ts`：`createWindowBridge()` 扩展 5 个方法；`ALLOWED_RENDERER_EVENT_CHANNELS` 增加 `window-state`

**渲染层（`apps/web`）**

- `src/lib/platform.ts`：新增 `isCustomWindowControlsPlatform`，修正注释
- `src/lib/desktop-runtime/bridge.ts`：`DesktopBridgeWindow` 接口加 5 个可选方法
- `src/lib/desktop-runtime/window.ts`：`getCurrentWindow()` 补 5 个方法
- `src/components/app-shell/TitleBar.tsx`：覆盖层 → 实体栏，三段式布局
- `src/components/app-shell/WindowButtons.tsx`（新）：min / max / close 按钮组件
- `src/components/app-shell/AppShell.tsx`：`flex` → `flex flex-col`，移除 `pt-*`

## 测试策略

测试框架为 vitest，参考现有 `electron-security.test.mjs` / `desktop-package.test.mjs` / 组件 `.test.tsx` 模式。

- `platform.test.ts`：mock `navigator.userAgent` + `isDesktopRuntime`，验证 `isCustomWindowControlsPlatform` 三平台分支
- `WindowButtons.test.tsx`：mock `getCurrentWindow()`，验证 min / max / close 调用、`maximized` 图标切换、`onMaximizeStateChange` 订阅正确取消
- `TitleBar.test.tsx`：验证 macOS 左 padding、Win/Linux 渲染 `WindowButtons`、`RightPanelWindowControls` 条件渲染
- `electron-security.test.mjs` 扩展：`lume:window-control` 的 sender 校验 + op 分发；`window-state` 加入事件通道白名单
- 三平台手动验收清单：macOS 交通灯避让 / Win/Linux 按钮与双击最大化 / 拖拽 / 失焦态

## 已知限制

1. **Win11 Snap Layouts hover 菜单不支持**：纯 HTML 路线（`titleBarStyle:'hidden'` 无 overlay）的固有限制，VS Code 等同类应用共有。用户仍可用拖窗口到屏幕边缘的 Aero Snap。
2. **Linux 圆角 / 阴影取决于窗口管理器**：`titleBarStyle:'hidden'` 保留边框但圆角/阴影由 WM 决定，不额外用 CSS 模拟。
3. **仅深色主题**：窗口按钮配色按深色实现，不做亮色适配。

## 未来工作

- 若需 Win11 Snap Layouts：Win 端切 `titleBarOverlay` 混合方案（仅按钮区原生）。
- 亮色主题适配（若应用引入主题切换）。
- 标签页栏上移至标题栏（当前未做，避免改动 `MainArea` 结构）。
