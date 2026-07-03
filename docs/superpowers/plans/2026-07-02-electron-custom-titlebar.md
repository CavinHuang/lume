# Electron 自定义窗口控制栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯 HTML 自定义标题栏替换 Windows/Linux 原生标题栏，承载侧栏开关/Logo/搜索/窗口控制按钮；macOS 保留原生交通灯。

**Architecture:** 主进程 `titleBarStyle:'hidden'`（Win/Linux）+ 新增 `lume:window-control` IPC 与 `window-state` 事件；preload 的 window bridge 扩展 5 个方法，经渲染层 `bridge.ts` 类型契约 → `window.ts` 封装 → `TitleBar.tsx` 实体栏消费。`AppShell` 由横向 flex 改纵向，让标题栏成为占据空间的实体栏。

**Tech Stack:** Electron 42、React 18、jotai、Tailwind v4、lucide-react；测试 web 用 `bun:test` + `react-dom/server` 的 `renderToStaticMarkup`，desktop 用 `node:test` + 源码扫描。

## Global Constraints

- **包管理器是 bun**（`packageManager: bun@1.3.13`）。web 测试：`cd apps/web && bun test <file>`；desktop 测试：`cd apps/desktop && bun test ./scripts/electron-security.test.mjs`（完整套件见 `apps/desktop/package.json:20`）。
- **代码注释用中文**，与现有代码库一致。
- **提交需用户明确授权**（项目 `CLAUDE.md`：未经主动要求绝不执行 git 操作）。计划中的 commit 步骤在执行前必须征得用户同意，或由用户自行提交。
- **视觉 token 沿用** `RightPanelWindowControls.tsx`：按钮 `size-8 rounded-[8px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground`，图标用 lucide-react。
- **仅深色主题**，不做亮色适配。
- **不改 `wereadWindow`**（保持原生 `autoHideMenuBar`）。
- 遵循 KISS / YAGNI / DRY / surgical changes：每行改动可追溯到设计目标。

## File Structure

**主进程 / preload（`apps/desktop`）**
- Modify `src/main.ts` — `createMainWindow` 的 `titleBarStyle`；新增 `lume:window-control` handler；`maximize`/`unmaximize` → `window-state` 事件
- Modify `src/preload.ts` — `createWindowBridge()` 扩展 5 方法；`ALLOWED_RENDERER_EVENT_CHANNELS` 加 `window-state`
- Modify `src/electron-security.ts` — `ALLOWED_RENDERER_EVENT_CHANNELS` 加 `window-state`（与 preload 同步）

**渲染层（`apps/web`）**
- Modify `src/lib/platform.ts` — 新增 `detectIsCustomWindowControlsPlatform` / `isCustomWindowControlsPlatform`
- Create `src/lib/platform.test.ts`
- Modify `src/lib/desktop-runtime/bridge.ts` — `DesktopBridgeWindow` 接口加 5 方法
- Modify `src/lib/desktop-runtime/window.ts` — `getCurrentWindow()` 补 5 方法
- Create `src/components/app-shell/app-region.ts` — `DRAG_REGION` / `NO_DRAG_REGION` 样式常量
- Create `src/components/app-shell/WindowButtons.tsx` — 窗口控制按钮（含可测的 `WindowButtonGroup` 展示组件）
- Create `src/components/app-shell/WindowButtons.test.tsx`
- Modify `src/components/app-shell/TitleBar.tsx` — 覆盖层 → 实体栏，三段式布局，`variant` 可注入便于测试
- Modify `src/components/app-shell/AppShell.tsx` — `flex` → `flex flex-col`，移除 `pt-*`
- Create `src/components/app-shell/TitleBar.test.tsx`

---

### Task 1: 平台判断 `isCustomWindowControlsPlatform`

把平台判断提取为纯函数（便于测试），新增 Windows/Linux 自绘按钮的判断常量。

**Files:**
- Modify: `apps/web/src/lib/platform.ts`
- Test: `apps/web/src/lib/platform.test.ts`

**Interfaces:**
- Consumes: `isDesktopRuntime` from `@/lib/desktop-runtime/core`
- Produces: `isCustomWindowControlsPlatform`（常量，Win/Linux 桌面端为 true）；`detectIsCustomWindowControlsPlatform(userAgent, desktop)`（纯函数）

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/platform.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  detectIsCustomWindowControlsPlatform,
  detectIsMacosDesktopShell,
} from './platform'

describe('detectIsMacosDesktopShell', () => {
  test('macOS 桌面端为 true', () => {
    expect(detectIsMacosDesktopShell('MacIntel', true)).toBe(true)
  })
  test('macOS 但非桌面端为 false', () => {
    expect(detectIsMacosDesktopShell('MacIntel', false)).toBe(false)
  })
  test('Windows 桌面端为 false', () => {
    expect(detectIsMacosDesktopShell('Win32', true)).toBe(false)
  })
  test('userAgent 缺失时为 false', () => {
    expect(detectIsMacosDesktopShell(undefined, true)).toBe(false)
  })
})

describe('detectIsCustomWindowControlsPlatform', () => {
  test('Windows 桌面端为 true（需自绘按钮）', () => {
    expect(detectIsCustomWindowControlsPlatform('Win32', true)).toBe(true)
  })
  test('Linux 桌面端为 true', () => {
    expect(detectIsCustomWindowControlsPlatform('Linux x86_64', true)).toBe(true)
  })
  test('macOS 桌面端为 false（保留原生交通灯）', () => {
    expect(detectIsCustomWindowControlsPlatform('MacIntel', true)).toBe(false)
  })
  test('浏览器（非桌面端）为 false', () => {
    expect(detectIsCustomWindowControlsPlatform('Win32', false)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/lib/platform.test.ts`
Expected: FAIL，报 `detectIsCustomWindowControlsPlatform` / `detectIsMacosDesktopShell` 未导出。

- [ ] **Step 3: Write minimal implementation**

Replace the body of `apps/web/src/lib/platform.ts` with:

```ts
import { isDesktopRuntime } from '@/lib/desktop-runtime/core'

/** 判定 macOS 桌面端的纯函数（便于测试）。 */
export function detectIsMacosDesktopShell(
  userAgent: string | undefined,
  desktop: boolean,
): boolean {
  return desktop && /Mac/i.test(userAgent ?? '')
}

/** 判定需自绘窗口按钮的平台（Windows/Linux 桌面端）的纯函数。 */
export function detectIsCustomWindowControlsPlatform(
  userAgent: string | undefined,
  desktop: boolean,
): boolean {
  return desktop && !detectIsMacosDesktopShell(userAgent, desktop)
}

const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined
const desktop = isDesktopRuntime()

/**
 * 是否运行在 macOS 桌面端（Electron shell）。
 * 仅此场景保留系统红绿灯按钮，需要在顶部为交通灯预留空间并保留拖拽区。
 */
export const isMacosDesktopShell = detectIsMacosDesktopShell(userAgent, desktop)

/**
 * 是否需要自绘窗口控制按钮（Windows/Linux 桌面端）。
 * macOS 保留原生交通灯，浏览器/SSR 无窗口控件需求。
 */
export const isCustomWindowControlsPlatform =
  detectIsCustomWindowControlsPlatform(userAgent, desktop)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun test src/lib/platform.test.ts`
Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add apps/web/src/lib/platform.ts apps/web/src/lib/platform.test.ts
git commit -m "✨ feat(web): 新增自绘窗口按钮平台判断"
```

---

### Task 2: 主进程窗口配置与窗口控制 IPC

`mainWindow` 改 frameless 标题栏样式；新增 `lume:window-control` handler（带 sender 校验）；最大化态变化推送 `window-state` 事件。

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/scripts/electron-security.test.mjs`

**Interfaces:**
- Consumes: `validateIpcSender(event, mainWindow)`、`emitRendererEvent(channel, payload)`、全局 `mainWindow`
- Produces: IPC 通道 `lume:window-control`（ops: `minimize` / `toggleMaximize` / `close` / `isMaximized`）；事件 `window-state`（payload `{ maximized: boolean }`）

- [ ] **Step 1: Write the failing tests**

在 `apps/desktop/scripts/electron-security.test.mjs` 末尾（`extractStringSet` 函数之前）追加：

```js
test("main window uses frameless title bar with platform-specific style", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(
    mainSource,
    /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'hidden'/,
  );
});

test("main process registers a window-control IPC handler", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /ipcMain\.handle\('lume:window-control'/);
});

test("main process pushes window-state events on maximize and unmaximize", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /emitRendererEvent\('window-state',\s*\{\s*maximized:\s*true\s*\}\)/);
  assert.match(mainSource, /emitRendererEvent\('window-state',\s*\{\s*maximized:\s*false\s*\}\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test ./scripts/electron-security.test.mjs`
Expected: 三个新用例 FAIL（源码尚未匹配）。

- [ ] **Step 3: Update `titleBarStyle`**

在 `apps/desktop/src/main.ts` 的 `createMainWindow`（约 317 行）把：

```ts
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
```

改为：

```ts
    // macOS 保留原生交通灯（hiddenInset）；Windows/Linux 仅隐藏标题栏，
    // 保留原生窗口边框、阴影与 resize 命中区，由渲染层自绘控制按钮。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
```

- [ ] **Step 4: 在 `createMainWindow` 内推送最大化态事件**

在 `apps/desktop/src/main.ts` 的 `createMainWindow` 中，找到 `attachWindowBehavior(win)`（约 324 行），在其**之后**追加：

```ts
  // 最大化/还原态变化推送给渲染层，驱动按钮图标切换。
  win.on('maximize', () => emitRendererEvent('window-state', { maximized: true }))
  win.on('unmaximize', () => emitRendererEvent('window-state', { maximized: false }))
```

- [ ] **Step 5: 新增 `lume:window-control` IPC handler**

在 `apps/desktop/src/main.ts` 中，找到现有 `ipcMain.handle('lume:relaunch', ...)`（约 778 行），在其**之前**插入：

```ts
ipcMain.handle('lume:window-control', async (event, op) => {
  validateIpcSender(event, mainWindow)
  if (!mainWindow) throw new Error('main window is not available')
  switch (op) {
    case 'minimize':
      mainWindow.minimize()
      return null
    case 'toggleMaximize':
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
      return null
    case 'close':
      mainWindow.close()
      return null
    case 'isMaximized':
      return mainWindow.isMaximized()
    default:
      throw new Error(`unsupported window-control op: ${String(op)}`)
  }
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop && bun test ./scripts/electron-security.test.mjs`
Expected: PASS（含三个新用例）。若 sync 用例报 preload/electron-security 白名单不同步，属预期——Task 3 会修复 `window-state` 通道。

- [ ] **Step 7: Typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误。

- [ ] **Step 8: Commit（需用户授权）**

```bash
git add apps/desktop/src/main.ts apps/desktop/scripts/electron-security.test.mjs
git commit -m "✨ feat(desktop): 主窗口改 frameless 标题栏与窗口控制 IPC"
```

---

### Task 3: preload window bridge 与事件白名单同步

preload 的 `createWindowBridge()` 暴露 5 个窗口控制方法；`window-state` 通道加入 `electron-security.ts` 与 `preload.ts` 两处白名单（被 sync 测试强制同步）。

**Files:**
- Modify: `apps/desktop/src/electron-security.ts`
- Modify: `apps/desktop/src/preload.ts`
- Test: `apps/desktop/scripts/electron-security.test.mjs`

**Interfaces:**
- Produces（preload bridge）：`minimize()` / `toggleMaximize()` / `close()` / `isMaximized()` / `onMaximizeStateChange(listener) => unsubscribe`，挂在 `electronAPI.window.*`

- [ ] **Step 1: Write the failing test**

在 `apps/desktop/scripts/electron-security.test.mjs` 的 `test("renderer event subscriptions are explicitly allowlisted", ...)` 用例（约 44 行）内，追加一行断言：

```js
  assert.equal(ALLOWED_RENDERER_EVENT_CHANNELS.has("window-state"), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test ./scripts/electron-security.test.mjs`
Expected: 该用例 FAIL（`window-state` 不在 set）。

- [ ] **Step 3: 把 `window-state` 加入权威白名单**

在 `apps/desktop/src/electron-security.ts:37-41`，把：

```ts
export const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
])
```

改为：

```ts
export const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
  'window-state',
])
```

- [ ] **Step 4: 把 `window-state` 同步进 preload 副本**

在 `apps/desktop/src/preload.ts:31-35`，把：

```ts
const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
])
```

改为：

```ts
const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
  'window-state',
])
```

- [ ] **Step 5: 扩展 `createWindowBridge()`**

在 `apps/desktop/src/preload.ts` 的 `createWindowBridge`（约 58 行）返回对象中，紧接现有 `onDragDropEvent` 之后追加 5 个方法（与 `startDragging` 同级）：

```ts
    async minimize() {
      return ipcRenderer.invoke('lume:window-control', 'minimize')
    },
    async toggleMaximize() {
      return ipcRenderer.invoke('lume:window-control', 'toggleMaximize')
    },
    async close() {
      return ipcRenderer.invoke('lume:window-control', 'close')
    },
    async isMaximized() {
      return ipcRenderer.invoke('lume:window-control', 'isMaximized')
    },
    onMaximizeStateChange(listener) {
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('lume:event:window-state', handler)
      return () => {
        ipcRenderer.removeListener('lume:event:window-state', handler)
      }
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop && bun test ./scripts/electron-security.test.mjs`
Expected: PASS（含 `window-state` 断言与 preload sync 用例）。

- [ ] **Step 7: Typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误。

- [ ] **Step 8: Commit（需用户授权）**

```bash
git add apps/desktop/src/electron-security.ts apps/desktop/src/preload.ts apps/desktop/scripts/electron-security.test.mjs
git commit -m "✨ feat(desktop): preload window bridge 暴露窗口控制 API"
```

---

### Task 4: 渲染层 bridge 类型契约与 `getCurrentWindow` 封装

`DesktopBridgeWindow` 接口加 5 个可选方法；`getCurrentWindow()` 转发这 5 个方法。渲染层 → preload 的契约层打通。

**Files:**
- Modify: `apps/web/src/lib/desktop-runtime/bridge.ts`
- Modify: `apps/web/src/lib/desktop-runtime/window.ts`

**Interfaces:**
- Consumes: preload 暴露的 `electronAPI.window.*`（Task 3）
- Produces: `getCurrentWindow()` 返回值含 `minimize` / `toggleMaximize` / `close` / `isMaximized` / `onMaximizeStateChange`

- [ ] **Step 1: 扩展 `DesktopBridgeWindow` 接口**

在 `apps/web/src/lib/desktop-runtime/bridge.ts:39-44`，把：

```ts
export interface DesktopBridgeWindow {
  startDragging?(): Promise<void>
  onDragDropEvent?(
    listener: (payload: unknown) => void
  ): Promise<() => void> | (() => void)
}
```

改为：

```ts
export interface DesktopBridgeWindow {
  startDragging?(): Promise<void>
  onDragDropEvent?(
    listener: (payload: unknown) => void
  ): Promise<() => void> | (() => void)
  minimize?(): Promise<void>
  toggleMaximize?(): Promise<void>
  close?(): Promise<void>
  isMaximized?(): Promise<boolean>
  onMaximizeStateChange?(
    listener: (payload: { maximized: boolean }) => void
  ): () => void
}
```

- [ ] **Step 2: 在 `getCurrentWindow()` 转发 5 个方法**

把 `apps/web/src/lib/desktop-runtime/window.ts` 整体替换为：

```ts
import {
  createDesktopUnavailableError,
  getDesktopBridge,
  type DesktopListenerEvent,
} from './bridge'

export function getCurrentWindow() {
  return {
    async startDragging(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.startDragging) {
        throw createDesktopUnavailableError('window.startDragging')
      }
      await bridge.window.startDragging()
    },
    async onDragDropEvent(
      listener: (event: DesktopListenerEvent<unknown>) => void
    ): Promise<() => void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.onDragDropEvent) return () => {}

      return Promise.resolve(
        bridge.window.onDragDropEvent((payload) => {
          listener({ payload })
        })
      )
    },
    async minimize(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.minimize) {
        throw createDesktopUnavailableError('window.minimize')
      }
      await bridge.window.minimize()
    },
    async toggleMaximize(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.toggleMaximize) {
        throw createDesktopUnavailableError('window.toggleMaximize')
      }
      await bridge.window.toggleMaximize()
    },
    async close(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.close) {
        throw createDesktopUnavailableError('window.close')
      }
      await bridge.window.close()
    },
    async isMaximized(): Promise<boolean> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.isMaximized) {
        throw createDesktopUnavailableError('window.isMaximized')
      }
      return bridge.window.isMaximized()
    },
    onMaximizeStateChange(
      listener: (payload: { maximized: boolean }) => void
    ): () => void {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.onMaximizeStateChange) return () => {}
      return bridge.window.onMaximizeStateChange(listener)
    },
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit（需用户授权）**

```bash
git add apps/web/src/lib/desktop-runtime/bridge.ts apps/web/src/lib/desktop-runtime/window.ts
git commit -m "✨ feat(web): 渲染层 window bridge 透传窗口控制方法"
```

---

### Task 5: `WindowButtons` 组件

窗口控制按钮组件。拆出纯展示 `WindowButtonGroup`（接收 `maximized` / `focused`，便于 SSR 测试）；容器 `WindowButtons` 订阅最大化态与窗口焦点。先建共享的 `app-region` 样式常量。

**Files:**
- Create: `apps/web/src/components/app-shell/app-region.ts`
- Create: `apps/web/src/components/app-shell/WindowButtons.tsx`
- Test: `apps/web/src/components/app-shell/WindowButtons.test.tsx`

**Interfaces:**
- Consumes: `getCurrentWindow()`（Task 4）；`cn` from `@/lib/utils`
- Produces: `<WindowButtons />`（仅在 `isCustomWindowControlsPlatform` 平台渲染）；`<WindowButtonGroup maximized focused />`（可测展示组件）

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/app-shell/WindowButtons.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WindowButtonGroup } from './WindowButtons'

describe('WindowButtonGroup', () => {
  test('非最大化态渲染最小化/最大化/关闭三个按钮', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={false} focused={true} />,
    )
    expect(markup).toContain('最小化')
    expect(markup).toContain('最大化')
    expect(markup).toContain('关闭')
    expect(markup).toContain('-webkit-app-region:no-drag')
  })

  test('最大化态把"最大化"切换为"还原"', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={true} focused={true} />,
    )
    expect(markup).toContain('还原')
    expect(markup).not.toContain('最大化')
  })

  test('失焦态应用降低对比度的样式', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={false} focused={false} />,
    )
    expect(markup).toContain('text-foreground/30')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/components/app-shell/WindowButtons.test.tsx`
Expected: FAIL，`WindowButtonGroup` 未导出。

- [ ] **Step 3: Create `app-region.ts` 共享样式常量**

Create `apps/web/src/components/app-shell/app-region.ts`:

```ts
import type { CSSProperties } from 'react'

/** 标记元素为窗口拖拽区（Electron 在 CSS 层拦截为系统级拖拽）。 */
export const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties

/** 标记元素排除拖拽，使其能正常接收点击。 */
export const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as CSSProperties
```

- [ ] **Step 4: Create `WindowButtons.tsx`**

Create `apps/web/src/components/app-shell/WindowButtons.tsx`:

```tsx
/**
 * WindowButtons - Windows/Linux 自绘窗口控制按钮
 *
 * 视觉 token 与 RightPanelWindowControls 一致（size-8 圆角按钮）。
 * macOS 不渲染此组件（保留原生交通灯）。
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@/lib/desktop-runtime/window'
import { cn } from '@/lib/utils'
import { NO_DRAG_REGION } from './app-region'

interface WindowButtonGroupProps {
  maximized: boolean
  focused: boolean
  className?: string
  style?: CSSProperties
}

/** 纯展示组件，便于在 SSR 测试中覆盖两种最大化态。 */
export function WindowButtonGroup({
  maximized,
  focused,
  className,
  style,
}: WindowButtonGroupProps) {
  const buttonClass = cn(
    'flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors',
    focused
      ? 'hover:bg-foreground/[0.06] hover:text-foreground'
      : 'text-foreground/30',
  )

  return (
    <div className={cn('flex items-center gap-1', className)} style={{ ...NO_DRAG_REGION, ...style }}>
      <button
        type="button"
        title="最小化"
        className={buttonClass}
        onClick={() => getCurrentWindow().minimize().catch(() => {})}
      >
        <Minus size={16} />
      </button>
      <button
        type="button"
        title={maximized ? '还原' : '最大化'}
        className={buttonClass}
        onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}
      >
        {maximized ? <Copy size={14} /> : <Square size={14} />}
      </button>
      <button
        type="button"
        title="关闭"
        className={cn(buttonClass, 'hover:bg-red-500/80 hover:text-white')}
        onClick={() => getCurrentWindow().close().catch(() => {})}
      >
        <X size={16} />
      </button>
    </div>
  )
}

export function WindowButtons({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false)
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    let active = true

    getCurrentWindow()
      .isMaximized()
      .then((value) => {
        if (active) setMaximized(value)
      })
      .catch(() => {})

    // onMaximizeStateChange 同步返回取消订阅函数（见 desktop-runtime/window.ts）。
    const unsubscribe = getCurrentWindow().onMaximizeStateChange((payload) => {
      setMaximized(Boolean(payload?.maximized))
    })

    const onBlur = () => setFocused(false)
    const onFocus = () => setFocused(true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    return () => {
      active = false
      unsubscribe?.()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return <WindowButtonGroup maximized={maximized} focused={focused} className={className} />
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun test src/components/app-shell/WindowButtons.test.tsx`
Expected: PASS（3 个用例）。

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit（需用户授权）**

```bash
git add apps/web/src/components/app-shell/app-region.ts apps/web/src/components/app-shell/WindowButtons.tsx apps/web/src/components/app-shell/WindowButtons.test.tsx
git commit -m "✨ feat(web): 新增自绘窗口控制按钮组件"
```

---

### Task 6: `TitleBar` 实体栏改造与 `AppShell` 布局

`TitleBar` 从透明覆盖层改为占据空间的实体栏（h-10），三段式布局（左：侧栏开关 + Logo；中：搜索/命令入口；右：右面板控件 + 窗口按钮）。`AppShell` 改纵向 flex，让标题栏占顶部一行。`TitleBar` 接收可注入的 `variant` 便于测试。

**Files:**
- Modify: `apps/web/src/components/app-shell/TitleBar.tsx`
- Modify: `apps/web/src/components/app-shell/AppShell.tsx`
- Test: `apps/web/src/components/app-shell/TitleBar.test.tsx`

**Interfaces:**
- Consumes: `isMacosDesktopShell` / `isCustomWindowControlsPlatform`（Task 1）；`commandPaletteOpenAtom` / `sidebarCollapsedAtom` from `@/atoms`；`<RightPanelWindowControls />`；`<WindowButtons />`（Task 5）；`DRAG_REGION` / `NO_DRAG_REGION`
- Produces: `<TitleBar variant? />`，默认从平台常量推导 variant

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/app-shell/TitleBar.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { TitleBar } from './TitleBar'

function render(variant: 'macos' | 'custom-controls' | 'browser'): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <TitleBar variant={variant} />
    </Provider>,
  )
}

describe('TitleBar', () => {
  test('渲染侧栏开关、Logo 与搜索入口', () => {
    const markup = render('browser')
    expect(markup).toContain('收起侧栏')
    expect(markup).toContain('Lume')
    expect(markup).toContain('搜索 / 跳转')
  })

  test('macOS 变体为交通灯预留左侧 80px', () => {
    const markup = render('macos')
    expect(markup).toContain('pl-[80px]')
  })

  test('custom-controls 变体渲染自绘窗口按钮', () => {
    const markup = render('custom-controls')
    expect(markup).toContain('最小化')
    expect(markup).toContain('关闭')
  })

  test('browser 变体不渲染自绘窗口按钮', () => {
    const markup = render('browser')
    expect(markup).not.toContain('最小化')
  })

  test('整条标题栏标记为拖拽区', () => {
    const markup = render('browser')
    expect(markup).toContain('-webkit-app-region:drag')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/components/app-shell/TitleBar.test.tsx`
Expected: FAIL，`TitleBar` 不接受 `variant` prop / 旧实现不渲染这些内容。

- [ ] **Step 3: Rewrite `TitleBar.tsx`**

Replace the entire contents of `apps/web/src/components/app-shell/TitleBar.tsx` with:

```tsx
/**
 * TitleBar - 桌面端自定义标题栏（实体栏）
 *
 * 左段：侧栏开关 + Logo（macOS 左侧留 80px 给原生交通灯）。
 * 中段：搜索 / 命令入口（点击打开命令面板，复用 Ctrl+K）。
 * 右段：右侧面板控件 + （Win/Linux）自绘窗口按钮。
 * macOS 保留原生交通灯，仅自绘中间内容。
 */

import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import { PanelLeft, Search, Sparkles } from 'lucide-react'
import { activeTabIdAtom, commandPaletteOpenAtom, sidebarCollapsedAtom, tabsAtom } from '@/atoms'
import { RightPanelWindowControls } from '@/components/right-panel'
import {
  isCustomWindowControlsPlatform,
  isMacosDesktopShell,
} from '@/lib/platform'
import { cn } from '@/lib/utils'
import { DRAG_REGION, NO_DRAG_REGION } from './app-region'
import { WindowButtons } from './WindowButtons'

export type TitleBarVariant = 'macos' | 'custom-controls' | 'browser'

function resolveVariant(): TitleBarVariant {
  if (isMacosDesktopShell) return 'macos'
  if (isCustomWindowControlsPlatform) return 'custom-controls'
  return 'browser'
}

export function TitleBar({ variant = resolveVariant() }: { variant?: TitleBarVariant }) {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const setOpen = useSetAtom(commandPaletteOpenAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeThreadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined

  return (
    <div
      data-testid="titlebar"
      data-variant={variant}
      style={DRAG_REGION}
      className={cn(
        'flex h-10 items-center gap-2 pr-2 select-none bg-background text-foreground',
        variant === 'macos' ? 'pl-[80px]' : 'pl-2',
      )}
      onDoubleClick={variant === 'custom-controls' ? () => {
        // Win/Linux 的 drag 区不自动双击最大化，需手动触发。
        void getCurrentWindowForDoubleClick(variant)
      } : undefined}
    >
      {/* 左段：侧栏开关 + Logo */}
      <div className="flex items-center gap-2" style={NO_DRAG_REGION}>
        <button
          type="button"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => setCollapsed(!collapsed)}
          className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <PanelLeft size={16} />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          <Sparkles size={16} className="text-primary" />
          <span className="text-sm font-medium">Lume</span>
        </div>
      </div>

      {/* 中段：搜索 / 命令入口（两侧留白可拖窗，按钮本身 no-drag） */}
      <div className="flex-1 flex justify-center" style={DRAG_REGION}>
        <button
          type="button"
          style={NO_DRAG_REGION}
          onClick={() => setOpen(true)}
          className="flex h-8 w-full max-w-[420px] items-center gap-2 rounded-[8px] bg-foreground/[0.04] px-3 text-sm text-foreground/40 hover:bg-foreground/[0.08]"
        >
          <Search size={14} />
          <span>搜索 / 跳转…</span>
        </button>
      </div>

      {/* 右段：右面板控件 + （Win/Linux）窗口按钮 */}
      <div className="flex items-center gap-2" style={NO_DRAG_REGION}>
        {activeThreadId && <RightPanelWindowControls />}
        {variant === 'custom-controls' && <WindowButtons />}
      </div>
    </div>
  )
}

/** 仅 custom-controls 平台需要双击最大化；避免在无桥接的环境调用。 */
async function getCurrentWindowForDoubleClick(variant: TitleBarVariant) {
  if (variant !== 'custom-controls') return
  const { getCurrentWindow } = await import('@/lib/desktop-runtime/window')
  await getCurrentWindow().toggleMaximize().catch(() => {})
}
```

> 说明：`onDoubleClick` 用动态 import + variant 守卫，确保 SSR/浏览器环境不会因 `getCurrentWindow` 在模块加载期求值而出错。WindowButtons 内部的点击/订阅已在 Task 5 处理了桥接缺失的兜底。

- [ ] **Step 4: Rewrite `AppShell.tsx` 为纵向 flex**

Replace the entire contents of `apps/web/src/components/app-shell/AppShell.tsx` with:

```tsx
import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { RightPanelWorkspace } from '@/components/right-panel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useSetAtom } from 'jotai'
import { commandPaletteOpenAtom } from '@/atoms'
import { useEffect } from 'react'

export function AppShell() {
  const setOpen = useSetAtom(commandPaletteOpenAtom)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setOpen])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 flex min-h-0 gap-2 p-2 pt-0">
        <LeftSidebar />
        <div className="flex-1 min-w-0">
          <MainArea />
        </div>
        <RightPanelWorkspace />
      </div>
      <CommandPalette />
    </div>
  )
}
```

> 说明：移除了原 `isMacosDesktopShell` 的 `pt-5`/`pt-0` 分支与 `cn` 导入——标题栏已是实体栏，交通灯由 `TitleBar` 内的 `pl-[80px]` 让位，内容区不再需要顶部留白。内容区 padding 统一在第二行容器处理。

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun test src/components/app-shell/TitleBar.test.tsx`
Expected: PASS（5 个用例）。

- [ ] **Step 6: Run full web test suite + typecheck**

Run: `cd apps/web && bun test src/components/app-shell/ && bun run typecheck`
Expected: 所有 app-shell 测试 PASS（含现有 `LeftSidebar.test.ts` / `ThreadItem.test.tsx` 等），typecheck 无错误。

- [ ] **Step 7: Commit（需用户授权）**

```bash
git add apps/web/src/components/app-shell/TitleBar.tsx apps/web/src/components/app-shell/AppShell.tsx apps/web/src/components/app-shell/TitleBar.test.tsx
git commit -m "✨ feat(web): TitleBar 改实体栏三段式布局"
```

---

## 验收手动清单（三平台，开发模式下逐项确认）

1. **macOS**：交通灯正常显示且可点；标题栏左侧内容不被交通灯遮挡（80px 让位）；拖拽空白区移动窗口；搜索框点击打开命令面板；侧栏开关可用。
2. **Windows**：无原生标题栏；自定义最小化/最大化/关闭按钮可用；双击标题栏空白区在最大化/还原间切换；最大化后按钮图标变为"还原"；关闭按钮 hover 变红；窗口失焦时按钮变暗。
3. **Linux**：同 Windows 行为；窗口边框/resize 把手保留（来自 `titleBarStyle:'hidden'`）。
4. **通用**：Ctrl+K 仍能打开命令面板；右侧面板控件在有活跃会话时出现；标签页/主区域布局正常，无内容被标题栏遮挡。

## 已知限制（来自设计文档，非本计划回归项）

- Win11 Snap Layouts hover 菜单不支持（纯 HTML 路线固有限制）。
- Linux 圆角/阴影取决于窗口管理器。
- 仅深色主题。
