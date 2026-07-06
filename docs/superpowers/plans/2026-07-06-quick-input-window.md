# 桌面快速输入子窗口（Alt+L）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按下 Alt+L 全局快捷键唤起一个独立的轻量子窗口，只渲染对话页面（消息列表 + 输入框 + workspace 选择器），复用现有 AgentView。

**Architecture:** 单 Web 入口 + URL 参数 `?view=quick-input` 分流到精简 Shell；主进程新增独立 BrowserWindow（常驻隐藏）+ Electron globalShortcut toggle；IPC 信任集合从单 mainWindow 升级为 {main, quickInput}；共享 sidecar 单例，会话/消息天然同步主窗口。

**Tech Stack:** Electron 42（globalShortcut / BrowserWindow / utilityProcess sidecar）、React 18 + jotai + tiptap（复用 AgentView）、desktop 测试用 `bun test` + `node:test`（scripts/*.test.mjs）、web 测试用 vitest。

## Global Constraints

- **不自动 git 提交**：按项目约定，本计划不内嵌 `git commit` 步骤；每个 task 以「测试通过」为 gate。是否提交由用户在全部 task 完成后统一决定（如需提交用 `rtk git` 前缀）。
- **命令前缀**：所有 shell 命令用 `rtk` 前缀（如 `rtk bun test`、`rtk vitest`）。RTK 无专用 filter 时 passthrough，始终安全。
- **白名单同步约束**：新增 IPC 命令必须同时加到 `apps/desktop/src/electron-security.ts` 的 `ALLOWED_RENDERER_INVOKE_COMMANDS` 与 `apps/desktop/src/preload.ts` 的同名集合，否则 `preload allowlists stay in sync` 测试失败。
- **窗口注册顺序约束**：`quickInputWindow = win` 赋值必须在该窗口 `loadURL` 之前（与 mainWindow 一致），否则渲染层加载即调 IPC 时信任集合尚未包含子窗口。
- **DevTools 约束**：子窗口在 dev 态**不**自动开 DevTools（避免破坏 `opens DevTools only for development windows` 源码扫描测试；调试时手动开）。
- **代码注释语言**：中文，与现有代码库一致。
- **typecheck 必过**：`cd apps/desktop && rtk bun run typecheck`（tsc --noEmit）。

---

## File Structure

**新建：**
- `apps/web/src/components/quick-input/QuickInputShell.tsx` — 运行时装配壳（Provider/TooltipProvider/Toaster + QuickInput），对应 App.tsx 的 Provider 子树
- `apps/web/src/components/quick-input/QuickInput.tsx` — 状态容器（threadId/workspace/Esc/新建对话/AgentView）
- `apps/web/src/components/quick-input/QuickInputWorkspaceSelector.tsx` — 紧凑只读 workspace 切换器
- `apps/web/src/components/quick-input/QuickInput.test.tsx` — QuickInput 行为单测

**修改：**
- `apps/desktop/src/electron-security.ts` — `validateIpcSender` 升级为窗口数组；`ALLOWED_RENDERER_INVOKE_COMMANDS` 加 `quick_input_hide`
- `apps/desktop/src/preload.ts` — `ALLOWED_RENDERER_INVOKE_COMMANDS` 加 `quick_input_hide`（同步）
- `apps/desktop/src/desktop-core.ts` — 新增纯函数 `computeToggleAction` / `computeQuickInputBounds` / `getQuickInputUrl`
- `apps/desktop/src/main.ts` — globalShortcut、quickInputWindow 变量、createQuickInputWindow、toggleQuickInput、emitRendererEvent 广播、validateIpcSender 调用点改造、dispatchCommand 新 case、will-quit 注销
- `apps/desktop/scripts/electron-security.test.mjs` — 更新 validateIpcSender 测试为数组形态
- `apps/desktop/scripts/desktop-core.test.mjs` — 新增三个纯函数测试
- `apps/web/src/App.tsx` — `?view=quick-input` 分流

---

## Task 1: 升级 validateIpcSender 接受受信任窗口集合

**Files:**
- Modify: `apps/desktop/src/electron-security.ts:58-66`
- Test: `apps/desktop/scripts/electron-security.test.mjs:54-68`

**Interfaces:**
- Produces: `validateIpcSender(event, trustedWindows)` — 第二参数接受单个窗口 `{webContents, isDestroyed?}` 或窗口数组；返回 `true` 或抛 `'untrusted ipc sender'` / `'no trusted window available'`。后续 task 的 main.ts 调用点依赖此新签名。

- [ ] **Step 1: 更新现有测试 + 加数组断言**

把 `apps/desktop/scripts/electron-security.test.mjs:54-68` 整个 test 块替换为：

```javascript
test("IPC handlers only accept trusted window webContents as sender", () => {
  const mainSender = { id: 1, isDestroyed: () => false };
  const quickSender = { id: 2, isDestroyed: () => false };
  const unknownSender = { id: 3, isDestroyed: () => false };
  const mainWindow = { isDestroyed: () => false, webContents: mainSender };
  const quickWindow = { isDestroyed: () => false, webContents: quickSender };

  // 单窗口向后兼容
  assert.equal(validateIpcSender({ sender: mainSender }, mainWindow), true);
  assert.throws(
    () => validateIpcSender({ sender: unknownSender }, mainWindow),
    /untrusted ipc sender/,
  );
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, { isDestroyed: () => true }),
    /no trusted window available/,
  );

  // 窗口数组：main 与 quickInput 都受信任
  assert.equal(
    validateIpcSender({ sender: mainSender }, [mainWindow, quickWindow]),
    true,
  );
  assert.equal(
    validateIpcSender({ sender: quickSender }, [mainWindow, quickWindow]),
    true,
  );
  assert.throws(
    () => validateIpcSender({ sender: unknownSender }, [mainWindow, quickWindow]),
    /untrusted ipc sender/,
  );

  // 空数组或全 null：拒绝
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, []),
    /no trusted window available/,
  );
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, [null, null]),
    /no trusted window available/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: FAIL — 现有 `validateIpcSender` 不接受数组，对数组形态抛错或行为不符。

- [ ] **Step 3: 升级 validateIpcSender**

把 `apps/desktop/src/electron-security.ts:58-66` 替换为：

```typescript
export function validateIpcSender(event, trustedWindows) {
  const windows = Array.isArray(trustedWindows) ? trustedWindows : [trustedWindows]
  const senders = windows
    .filter((win) => win && !win.isDestroyed?.())
    .map((win) => win.webContents)
  if (senders.length === 0) {
    throw new Error('no trusted window available')
  }
  if (!event || event.sender?.isDestroyed?.()) {
    throw new Error('untrusted ipc sender')
  }
  if (!senders.includes(event.sender)) {
    throw new Error('untrusted ipc sender')
  }
  return true
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: PASS（全部用例，包括其他未改动的测试）。

- [ ] **Step 5: typecheck**

Run: `cd apps/desktop && rtk bun run typecheck`
Expected: 无错误退出。

---

## Task 2: 新增 quick_input_hide 命令到 IPC 白名单（双处同步）

**Files:**
- Modify: `apps/desktop/src/electron-security.ts:9-35`（`ALLOWED_RENDERER_INVOKE_COMMANDS`）
- Modify: `apps/desktop/src/preload.ts:3-29`（同名集合，必须同步）

**Interfaces:**
- Produces: 白名单含 `'quick_input_hide'`，渲染层可通过 `invoke('quick_input_hide')` 触发子窗口隐藏。`preload allowlists stay in sync` 测试会校验两处一致。

- [ ] **Step 1: 在 electron-security.ts 白名单加命令**

在 `apps/desktop/src/electron-security.ts` 的 `ALLOWED_RENDERER_INVOKE_COMMANDS` 集合里，于 `'open_weread_key_webview'` 之后、`'data_get_storage_stats'` 之前，插入一行：

```typescript
  'open_weread_key_webview',
  'quick_input_hide',
  'data_get_storage_stats',
```

- [ ] **Step 2: 在 preload.ts 白名单同步加命令**

在 `apps/desktop/src/preload.ts` 的 `ALLOWED_RENDERER_INVOKE_COMMANDS` 集合同样位置插入同一行 `'quick_input_hide',`（顺序与 electron-security.ts 保持一致，便于同步测试匹配）。

- [ ] **Step 3: 运行同步测试确认通过**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: PASS — 「renderer IPC commands are explicitly allowlisted」与「preload allowlists stay in sync」均通过。

- [ ] **Step 4: typecheck**

Run: `cd apps/desktop && rtk bun run typecheck`
Expected: 无错误退出。

---

## Task 3: 抽 desktop-core 纯函数（toggle 状态机 / 窗口尺寸 / URL）

**Files:**
- Modify: `apps/desktop/src/desktop-core.ts`（新增三个导出函数）
- Test: `apps/desktop/scripts/desktop-core.test.mjs`（已存在，追加用例）

**Interfaces:**
- Produces:
  - `computeToggleAction({ exists, visible, destroyed? }) → 'create' | 'hide' | 'show'`
  - `computeQuickInputBounds(workArea: { width, height }) → { width, height, x, y }`
  - `getQuickInputUrl({ appIsPackaged, appProtocolOrigin, devServerUrl }) → string`
- main.ts（Task 4/5）依赖这三个函数。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/scripts/desktop-core.test.mjs` 顶部 import 区追加（若已 import 自 `../src/desktop-core` 则合并）：

```javascript
import {
  computeToggleAction,
  computeQuickInputBounds,
  getQuickInputUrl,
} from "../src/desktop-core.ts";
```

在文件末尾追加：

```javascript
test("computeToggleAction returns the right quick-input visibility transition", () => {
  assert.equal(computeToggleAction({ exists: false, visible: false }), "create");
  assert.equal(computeToggleAction({ exists: true, visible: false }), "show");
  assert.equal(computeToggleAction({ exists: true, visible: true }), "hide");
  assert.equal(computeToggleAction({ exists: true, visible: true, destroyed: true }), "create");
});

test("computeQuickInputBounds centers horizontally and places y near upper third", () => {
  const bounds = computeQuickInputBounds({ width: 1920, height: 1080 });
  assert.equal(bounds.width, 760);
  assert.equal(bounds.height, 600);
  assert.equal(bounds.x, Math.round((1920 - 760) / 2));
  // y 落在屏幕上 1/3 附近（允许实现细节，断言区间）
  assert.equal(bounds.y >= 0 && bounds.y <= 360, true);
  // 小屏不溢出
  const small = computeQuickInputBounds({ width: 800, height: 500 });
  assert.equal(small.x >= 0, true);
  assert.equal(small.y >= 0, true);
});

test("getQuickInputUrl builds dev and packaged entry urls with the view flag", () => {
  assert.equal(
    getQuickInputUrl({
      appIsPackaged: false,
      appProtocolOrigin: "lume://app",
      devServerUrl: "http://127.0.0.1:3000",
    }),
    "http://127.0.0.1:3000/?view=quick-input",
  );
  assert.equal(
    getQuickInputUrl({
      appIsPackaged: true,
      appProtocolOrigin: "lume://app",
      devServerUrl: "http://127.0.0.1:3000",
    }),
    "lume://app/index.html?view=quick-input",
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && rtk bun test ./scripts/desktop-core.test.mjs`
Expected: FAIL — 三个函数未导出（import 报错或 `undefined is not a function`）。

- [ ] **Step 3: 在 desktop-core.ts 实现三个纯函数**

在 `apps/desktop/src/desktop-core.ts` 末尾追加（紧贴现有导出风格，不加新 import）：

```typescript
/** 快速输入窗口 toggle 状态机：根据窗口当前存在性/可见性决定下一步动作。 */
export function computeToggleAction(state: {
  exists: boolean
  visible: boolean
  destroyed?: boolean
}): 'create' | 'hide' | 'show' {
  if (!state.exists || state.destroyed) return 'create'
  if (state.visible) return 'hide'
  return 'show'
}

/** 计算快速输入窗口尺寸与位置：水平居中，垂直落在工作区上 1/3 附近（Spotlight 风格）。 */
export function computeQuickInputBounds(workArea: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const width = 760
  const height = 600
  const x = Math.max(0, Math.round((workArea.width - width) / 2))
  const y = Math.max(0, Math.round(workArea.height / 3 - height / 2))
  return { width, height, x, y }
}

/** 构建快速输入窗口加载 URL：dev 走 dev server，packaged 走 app 协议入口，均带 ?view=quick-input。 */
export function getQuickInputUrl(opts: {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
}): string {
  if (opts.appIsPackaged) {
    return `${opts.appProtocolOrigin}/index.html?view=quick-input`
  }
  return `${opts.devServerUrl}/?view=quick-input`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/desktop && rtk bun test ./scripts/desktop-core.test.mjs`
Expected: PASS（三个新用例 + 既有用例）。

- [ ] **Step 5: typecheck**

Run: `cd apps/desktop && rtk bun run typecheck`
Expected: 无错误退出。

---

## Task 4: main.ts 改造信任调用点 + emitRendererEvent 广播两窗口

**Files:**
- Modify: `apps/desktop/src/main.ts`（新增 `quickInputWindow` 变量、`getTrustedWindows`、改 `emitRendererEvent`、改 6 处 `validateIpcSender` 调用点）

**Interfaces:**
- Consumes: Task 1 的 `validateIpcSender(event, windowsArray)` 新签名。
- Produces: `emitRendererEvent` 向 mainWindow 与 quickInputWindow 同时广播；IPC 信任集合纳入子窗口（`lume:window-control` 仍只信 main，因其操作 mainWindow）。

- [ ] **Step 1: 新增 quickInputWindow 模块变量与 getTrustedWindows**

在 `apps/desktop/src/main.ts:86-93`（`let mainWindow = null` 那一组变量）之后追加：

```typescript
let quickInputWindow = null

/** 当前受信任的渲染窗口集合：mainWindow 总在列；quickInputWindow 存在时纳入。 */
function getTrustedWindows() {
  return [mainWindow, quickInputWindow].filter(Boolean)
}
```

- [ ] **Step 2: 改 emitRendererEvent 广播两窗口**

把 `apps/desktop/src/main.ts:136-139` 的 `emitRendererEvent` 替换为：

```typescript
function emitRendererEvent(channel, payload) {
  for (const win of [mainWindow, quickInputWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(`lume:event:${channel}`, payload)
    }
  }
}
```

- [ ] **Step 3: 改 5 处通用 IPC 调用点为信任集合**

在 `apps/desktop/src/main.ts` 中，把以下 5 处 `validateIpcSender(event, mainWindow)` 改为 `validateIpcSender(event, getTrustedWindows())`：
- `ipcMain.handle('lume:invoke', ...)` 内（约 L789）
- `ipcMain.handle('lume:relaunch', ...)` 内（约 L813）
- `ipcMain.handle('lume:update:check', ...)` 内（约 L821）
- `ipcMain.handle('lume:update:download', ...)` 内（约 L829）
- `ipcMain.handle('lume:update:install', ...)` 内（约 L867）

**保留** `ipcMain.handle('lume:window-control', ...)` 内的 `validateIpcSender(event, mainWindow)` 不变（约 L793）—— 该通道最小化/最大化主窗口，不应被子窗口触发；保持单 mainWindow 校验。

- [ ] **Step 4: 验证 security 测试仍通过**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: PASS（源码扫描类测试不依赖调用点形态；功能测试在 Task 1 已覆盖）。

- [ ] **Step 5: typecheck**

Run: `cd apps/desktop && rtk bun run typecheck`
Expected: 无错误退出。

---

## Task 5: main.ts 接入 globalShortcut + createQuickInputWindow + dispatchCommand case

**Files:**
- Modify: `apps/desktop/src/main.ts`（globalShortcut import、createQuickInputWindow、toggleQuickInput、dispatchCommand 加 case、app.whenReady 注册、will-quit 注销）
- Test: `apps/desktop/scripts/electron-security.test.mjs`（追加源码扫描断言）

**Interfaces:**
- Consumes: Task 2 的 `quick_input_hide` 白名单；Task 3 的 `computeToggleAction` / `computeQuickInputBounds` / `getQuickInputUrl`。
- Produces: Alt+L 全局快捷键 toggle；`quick_input_hide` 命令隐藏子窗口。

- [ ] **Step 1: 追加源码扫描测试**

在 `apps/desktop/scripts/electron-security.test.mjs` 末尾（`extractStringSet` helper 之前）追加：

```javascript
test("main process registers Alt+L global shortcut after app ready", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /globalShortcut\.register\(['"]Alt\+L['"]/);
  assert.match(mainSource, /globalShortcut\.unregisterAll\(\)/);
});

test("quick input window is registered before its renderer loads", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const registerIndex = mainSource.indexOf("quickInputWindow = win");
  const loadIndex = mainSource.indexOf("getQuickInputUrl(");
  assert.notEqual(registerIndex, -1, "quick input window is never assigned");
  assert.notEqual(loadIndex, -1, "quick input window never loads its url");
  assert.equal(registerIndex < loadIndex, true, "quick input window must register before load");
});

test("dispatchCommand handles quick_input_hide", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /case 'quick_input_hide'/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: FAIL — 三个新用例断言的源码片段尚不存在。

- [ ] **Step 3: 引入 globalShortcut import**

在 `apps/desktop/src/main.ts:1-14` 的 electron import 解构里加入 `globalShortcut`（与 `app, BrowserWindow, ...` 同组，按字母序插入 `net` 之前）：

```typescript
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  nativeImage,
  protocol,
  shell,
  utilityProcess,
} from 'electron'
```

并在从 `./desktop-core` 的 import 列表（L27-55）中加入三个新函数（按现有字母序位置插入）：

```typescript
  computeQuickInputBounds,
  computeStorageStats,
  computeToggleAction,
```

（`getQuickInputUrl` 同样加入该 import 列表，紧贴 `getNativeBinaryPath` 附近或列表末尾，保持字母序。）

- [ ] **Step 4: 实现 createQuickInputWindow 与 toggleQuickInput**

在 `apps/desktop/src/main.ts` 的 `createMainWindow` 函数之后、`dispatchCommand` 之前，插入：

```typescript
async function createQuickInputWindow() {
  const win = new BrowserWindow({
    title: 'Lume Quick Input',
    icon: createWindowIcon(),
    ...computeQuickInputBounds(screen.getPrimaryDisplay().workAreaSize),
    minWidth: 520,
    minHeight: 400,
    backgroundColor: '#111827',
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: createSecureWebPreferences({
      preload: resolve(DESKTOP_ROOT, 'dist', 'preload', 'preload.cjs'),
    }),
  })
  // 关键：先注册到信任集合，再加载渲染层（加载即可能调 IPC）
  quickInputWindow = win

  attachWebContentsSecurity(win, {
    allowNavigation: (url) => isAllowedMainFrameNavigation(url, {
      appIsPackaged: app.isPackaged,
      appProtocolOrigin: APP_PROTOCOL_ORIGIN,
      devServerUrl: getDevServerUrl(),
      webEntryPath: getWebEntryPath(),
    }),
  })

  // 隐藏而非关闭：复用 isQuitting 模式，应用退出时才真关闭
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (quickInputWindow === win) quickInputWindow = null
  })

  await win.loadURL(getQuickInputUrl({
    appIsPackaged: app.isPackaged,
    appProtocolOrigin: APP_PROTOCOL_ORIGIN,
    devServerUrl: getDevServerUrl(),
  }))

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  return win
}

async function toggleQuickInput() {
  const exists = Boolean(quickInputWindow) && !quickInputWindow.isDestroyed()
  const action = computeToggleAction({
    exists,
    visible: exists && quickInputWindow.isVisible(),
    destroyed: exists ? quickInputWindow.isDestroyed() : undefined,
  })
  if (action === 'create') {
    await createQuickInputWindow()
    return
  }
  if (action === 'hide') {
    quickInputWindow.hide()
    return
  }
  quickInputWindow.show()
  quickInputWindow.focus()
}
```

> 注：`screen` 来自 electron，需在 main.ts 顶部 electron import 解构中加入 `screen`（与 `globalShortcut` 同组）。在 Step 3 的 import 块里一并加入 `screen,`（置于 `protocol,` 与 `shell,` 之间）。

- [ ] **Step 5: dispatchCommand 加 quick_input_hide case**

在 `apps/desktop/src/main.ts` 的 `dispatchCommand` switch 中，`case 'desktop_sync_window_behavior':` 之后、`case 'open_file_dialog':` 之前，插入：

```typescript
    case 'quick_input_hide':
      if (quickInputWindow && !quickInputWindow.isDestroyed()) {
        quickInputWindow.hide()
      }
      return null
```

- [ ] **Step 6: app.whenReady 注册快捷键 + will-quit 注销**

在 `apps/desktop/src/main.ts:873-884` 的 `app.whenReady().then(async () => {...})` 内，`await createMainWindow()` 之后、`.catch` 之前，加入：

```typescript
  globalShortcut.register('Alt+L', () => {
    toggleQuickInput().catch((error) => {
      console.error(`[desktop] quick input toggle failed: ${error.message}`)
    })
  })
```

在 `app.on('will-quit', ...)`（L908-910）内，`await sidecarHost.stop()` 之后加入：

```typescript
  globalShortcut.unregisterAll()
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd apps/desktop && rtk bun test ./scripts/electron-security.test.mjs`
Expected: PASS（含三个新源码扫描用例）。

- [ ] **Step 8: 运行 desktop 全套测试**

Run: `cd apps/desktop && rtk bun test`
Expected: PASS（所有 scripts/*.test.mjs）。

- [ ] **Step 9: typecheck**

Run: `cd apps/desktop && rtk bun run typecheck`
Expected: 无错误退出。

---

## Task 6: App.tsx 按 ?view=quick-input 分流

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Produces: URL 含 `?view=quick-input` 时 App 直接渲染 `<QuickInputShell/>`，跳过 healthcheck/boot。`QuickInputShell` 由 Task 7 实现；本 task 先建一个最小占位导出，使 App.tsx 能编译通过。

- [ ] **Step 1: 先建 QuickInputShell 占位（让 Task 6 可独立编译/验证）**

创建 `apps/web/src/components/quick-input/QuickInputShell.tsx`：

```tsx
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'

/**
 * 快速输入子窗口的运行时装配壳。结构与 App.tsx 的 Provider 子树一致：
 * Provider + TooltipProvider + Toaster + 子内容。Task 7 会把 <QuickInput/> 接入。
 */
export function QuickInputShell() {
  return (
    <Provider>
      <TooltipProvider>
        <div className="h-screen w-screen" />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
```

- [ ] **Step 2: App.tsx 顶部加分流**

在 `apps/web/src/App.tsx` 顶部 import 区加入：

```tsx
import { QuickInputShell } from '@/components/quick-input/QuickInputShell'
```

在 `export function App()` 内、`useState(ready)` 之前，插入分流早返回：

```tsx
export function App() {
  // 快速输入子窗口：URL 带 ?view=quick-input 时走精简 Shell，跳过 healthcheck/boot。
  // sidecar 由主进程单例启动，子窗口加载时后端已就绪；sidecar_call 失败由 toast 兜底。
  const isQuickInput =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('view') === 'quick-input'
  if (isQuickInput) {
    return <QuickInputShell />
  }

  const [ready, setReady] = useState(false)
  // ...原逻辑保持不变
```

（注意：把原本 `const [ready, setReady] = useState(false)` 那一行下移到分流块之后，保持其余 hook 调用顺序不变——React 规则要求条件 return 之前的 hook 必须无条件执行；这里分流块在所有 useState/useEffect 之前，不违反规则。）

- [ ] **Step 3: typecheck + 构建**

Run: `cd apps/web && rtk tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 运行 web 现有测试确认未回归**

Run: `cd apps/web && rtk vitest run src/App.tsx` （若无 App 专属测试则跳过；改跑 `rtk vitest run` 全量，关注无回归）
Expected: 现有用例 PASS。

---

## Task 7: QuickInput 状态容器 + Workspace 选择器 + 接入 AgentView

**Files:**
- Create: `apps/web/src/components/quick-input/QuickInputWorkspaceSelector.tsx`
- Create: `apps/web/src/components/quick-input/QuickInput.tsx`
- Modify: `apps/web/src/components/quick-input/QuickInputShell.tsx`（接入 QuickInput）
- Test: `apps/web/src/components/quick-input/QuickInput.test.tsx`

**Interfaces:**
- Consumes: `createThread(workspaceId?)` from `@/lib/desktop-api`；`invoke(command)` from `@/lib/desktop-runtime/core`；`AgentView({ threadId })` from `@/components/agent/AgentView`；atoms `agentWorkspacesAtom` / `currentWorkspaceIdAtom` from `@/atoms`；hooks `useGlobalAgentListeners` / `useWorkspaceBootstrap`。
- Produces: 完整可用的快速输入对话窗口。

- [ ] **Step 1: 写 QuickInput 行为失败测试**

创建 `apps/web/src/components/quick-input/QuickInput.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { Provider } from 'jotai'
import { QuickInput } from './QuickInput'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'

// mocks 必须在 import QuickInput 之前
vi.mock('@/lib/desktop-api', () => ({
  createThread: vi.fn(async (workspaceId?: string) => ({ id: `thread-${workspaceId ?? 'none'}-1` })),
}))
vi.mock('@/lib/desktop-runtime/core', () => ({
  invoke: vi.fn(async () => undefined),
}))
vi.mock('@/hooks/useGlobalAgentListeners', () => ({
  useGlobalAgentListeners: () => {},
}))
vi.mock('@/hooks/useWorkspaceBootstrap', () => ({
  useWorkspaceBootstrap: () => {},
}))
vi.mock('@/components/agent/AgentView', () => ({
  AgentView: ({ threadId }: { threadId: string }) => (
    <div data-testid="agent-view">thread:{threadId}</div>
  ),
}))

import { createThread } from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'

function renderWith(workspaces: { id: string; name: string; slug: string }[], currentId: string | null) {
  const store = document.createElement('div')
  return render(
    <Provider
      initialValues={[
        [agentWorkspacesAtom, workspaces] as const,
        [currentWorkspaceIdAtom, currentId] as const,
      ]}
    >
      <QuickInput />
    </Provider>,
    { container: document.body.appendChild(store) },
  )
}

describe('QuickInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('在 workspace 就绪后创建首个会话并渲染 AgentView', async () => {
    renderWith([{ id: 'ws-1', name: '默认', slug: 'default' }], 'ws-1')
    expect(await screen.findByTestId('agent-view')).toHaveTextContent('thread:ws-1-1')
    expect(createThread).toHaveBeenCalledWith('ws-1')
  })

  it('点击「新建对话」再次创建会话', async () => {
    renderWith([{ id: 'ws-1', name: '默认', slug: 'default' }], 'ws-1')
    await screen.findByTestId('agent-view')
    ;(createThread as any).mockClear()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    })
    expect(createThread).toHaveBeenCalled()
  })

  it('按 Esc 触发 quick_input_hide', async () => {
    renderWith([{ id: 'ws-1', name: '默认', slug: 'default' }], 'ws-1')
    await screen.findByTestId('agent-view')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(invoke).toHaveBeenCalledWith('quick_input_hide')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && rtk vitest run src/components/quick-input/QuickInput.test.tsx`
Expected: FAIL — `QuickInput` 组件尚未实现。

- [ ] **Step 3: 实现 QuickInputWorkspaceSelector（紧凑只读切换器）**

创建 `apps/web/src/components/quick-input/QuickInputWorkspaceSelector.tsx`：

```tsx
import { FolderOpen, ChevronDown } from 'lucide-react'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef } from 'react'

interface Props {
  onChange: (workspaceId: string) => void
}

/**
 * 快速输入窗口顶部的紧凑 workspace 切换器。只读切换（不含新建/重命名/删除，
 * 那些在主窗口完成）。切换即触发父级 onChange。
 */
export function QuickInputWorkspaceSelector({ onChange }: Props) {
  const [workspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-foreground/70 hover:bg-foreground/[0.06]"
      >
        <FolderOpen size={13} className="text-foreground/50" />
        <span className="max-w-[120px] truncate">{current?.name ?? '工作区'}</span>
        <ChevronDown size={11} className={cn('text-foreground/40 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-border/60 bg-popover shadow-lg py-1">
          {workspaces.map((ws) => (
            <Button
              key={ws.id}
              variant="ghost"
              onClick={() => {
                setCurrentId(ws.id)
                onChange(ws.id)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] justify-start',
                ws.id === current?.id ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/70 hover:bg-foreground/[0.04]',
              )}
            >
              <FolderOpen size={12} className="text-foreground/40" />
              <span className="truncate">{ws.name}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
```

> 清理：删除 `const capabilities = useAtomValue({} as any)` 这一行（它仅是草稿占位）。最终文件不含该行。

- [ ] **Step 4: 实现 QuickInput（状态容器）**

创建 `apps/web/src/components/quick-input/QuickInput.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { createThread } from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useWorkspaceBootstrap } from '@/hooks/useWorkspaceBootstrap'
import { AgentView } from '@/components/agent/AgentView'
import { QuickInputWorkspaceSelector } from './QuickInputWorkspaceSelector'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DRAG_REGION, NO_DRAG_REGION } from '@/components/app-shell/app-region'
import { toast } from 'sonner'

/**
 * 快速输入窗口主体：管理 threadId 与 workspace，装配全局监听器，
 * Esc 隐藏窗口，「新建对话」与 workspace 切换都会重建会话。
 */
export function QuickInput() {
  useGlobalAgentListeners()
  useWorkspaceBootstrap()
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [threadId, setThreadId] = useState<string | null>(null)

  // workspace 就绪后创建首个会话（useWorkspaceBootstrap 首次启动时异步创建默认 workspace）
  useEffect(() => {
    if (threadId || workspaces.length === 0) return
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createThread(seed ?? undefined)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }, [workspaces.length])

  const handleNewThread = () => {
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createThread(seed ?? undefined)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }

  const handleWorkspaceChange = (workspaceId: string) => {
    setCurrentWorkspaceId(workspaceId)
    // 切换即新建：让选择器始终反映当前会话的 workspace
    createThread(workspaceId)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }

  // Esc 隐藏窗口
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('quick_input_hide').catch(() => {})
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden rounded-[10px] bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)]">
      <header style={DRAG_REGION} className="flex items-center gap-2 px-3 h-10 border-b border-border/40 select-none">
        <div style={NO_DRAG_REGION} className="flex items-center">
          <QuickInputWorkspaceSelector onChange={handleWorkspaceChange} />
        </div>
        <div className="flex-1" />
        <div style={NO_DRAG_REGION}>
          <Button variant="ghost" onClick={handleNewThread} className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/60 hover:bg-foreground/[0.06]">
            <Plus size={13} />
            新建对话
          </Button>
        </div>
      </header>
      <main className="flex-1 min-h-0">
        {threadId ? (
          <AgentView threadId={threadId} />
        ) : (
          <div className="h-full grid place-items-center text-[12px] text-muted-foreground">准备会话…</div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 5: QuickInputShell 接入 QuickInput**

把 Task 6 占位的 `apps/web/src/components/quick-input/QuickInputShell.tsx` 替换为：

```tsx
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { QuickInput } from './QuickInput'

/**
 * 快速输入子窗口的运行时装配壳。结构与 App.tsx 的 Provider 子树一致，
 * 让 AgentView 拿到与主窗口相同的 jotai Provider / Tooltip / Toaster 运行时。
 */
export function QuickInputShell() {
  return (
    <Provider>
      <TooltipProvider>
        <QuickInput />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/web && rtk vitest run src/components/quick-input/QuickInput.test.tsx`
Expected: PASS（三个用例）。

- [ ] **Step 7: typecheck + 全量 web 测试无回归**

Run: `cd apps/web && rtk tsc --noEmit`
Expected: 无错误。

Run: `cd apps/web && rtk vitest run`
Expected: 现有用例 PASS（关注新组件相关与 agent 相关无回归）。

---

## Task 8: 端到端手动 QA

**Files:** 无（验证步骤）

- [ ] **Step 1: 启动 dev 桌面端**

Run: `cd apps/desktop && rtk bun run dev`（或仓库根的统一 dev 命令）
Expected: 主窗口正常启动，sidecar 就绪。

- [ ] **Step 2: 验证 Alt+L 唤起/隐藏**

- 在任意应用焦点下按 `Alt+L` → 快速窗口出现（居中偏上、无框、760×600、不在任务栏）。
- 再按 `Alt+L` → 窗口隐藏。
- 按 `Esc` → 窗口隐藏。
- 失焦（点其他窗口）→ 快速窗口**不**自动隐藏（符合设计）。

- [ ] **Step 3: 验证对话全流程**

- 唤起后输入消息发送 → 看到 assistant 流式响应。
- 切换顶部 workspace 选择器 → 自动新建该 workspace 的会话。
- 点「新建对话」→ 换为新空会话。
- 打开主窗口侧边栏 → 快速会话出现在列表中（共享 sidecar 验证）。

- [ ] **Step 4: 验证回归**

- 主窗口 Cmd/Ctrl+K 命令面板仍正常。
- 主窗口收发消息正常，与快速窗口各自会话不串扰。
- 应用退出（tray → Quit）无报错；重开 Alt+L 仍可用。

---

## Self-Review

**Spec coverage:**
- §4.1 globalShortcut 注册/注销 → Task 5 Step 3/6 ✓
- §4.2 quickInputWindow 生命周期 + close/closed 处理 → Task 5 Step 4 ✓
- §4.3 emitRendererEvent 广播 → Task 4 Step 2 ✓
- §4.4 validateIpcSender 升级 + 调用点（window-control 限 main） → Task 1 + Task 4 Step 3 ✓
- §4.5 quick_input_hide 命令（双白名单同步） → Task 2 ✓
- §5.1 App.tsx 分流 → Task 6 ✓
- §5.2 QuickInputShell 装配 → Task 6 Step 1 + Task 7 Step 5 ✓
- §5.3 QuickInput 状态容器（workspace 时序、Esc、新建、切换即新建） → Task 7 Step 4 ✓
- §5.4 QuickInputWorkspaceSelector → Task 7 Step 3 ✓
- §7 交互细节（760×600/无框/skipTaskbar/alwaysOnTop:false/Esc） → Task 5 Step 4 + Task 7 ✓
- §8 错误处理（createThread toast、register 失败 console.error） → Task 5/7 ✓
- §9 测试（纯函数 + validateIpcSender + QuickInput 行为） → Task 1/3/5/7 ✓

**Placeholder scan:** 无 TBD/TODO；所有代码示例为可直接落地的最终态。

**Type consistency:** `computeToggleAction` / `computeQuickInputBounds` / `getQuickInputUrl` 在 Task 3 定义、Task 5 消费，签名一致；`validateIpcSender(event, windowsArray)` 在 Task 1 定义、Task 4 消费一致；`createThread(workspaceId?)` 签名取自现有 `agent.ts:47`；`AgentView({ threadId })` 取自现有 `AgentView.tsx:43`；`invoke('quick_input_hide')` 取自 `desktop-runtime/core.ts:11`。

**已识别的执行注意点（非阻塞）：**
- `createThread` 返回类型在 `agent.ts` 未显式泛型，代码用 `(thread as any)?.id` 兜底；若执行时确认返回 `{ id: string }`，可去掉 `as any` 并补类型。
- Task 6 的 App.tsx 分流放在所有 useState/useEffect 之前，符合 React hooks 规则；执行时勿打乱顺序。
