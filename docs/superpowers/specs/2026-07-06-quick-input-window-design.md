# 桌面快速输入子窗口（Alt+L）设计

- 日期：2026-07-06
- 状态：已批准，待实现
- 关联分支：codex/electron-final-cutover

## 1. 背景与目标

为 Lume 桌面端增加一个「快速输入框」：按下 **Alt+L** 全局快捷键，唤起一个独立的轻量子窗口，只包含对话页面（消息列表 + 输入框）。对标 Spotlight / Raycast AI 的「随时唤起、即用即走」体验，但复用现有 Agent 对话能力。

**成功标准**

- 任何应用/桌面焦点下按 Alt+L，都能在 < 300ms 内显示/隐藏快速窗口（首次创建窗口除外）。
- 窗口内可完成完整对话：发消息、看流式响应、切 workspace、新建对话。
- 快速窗口产生的会话自动出现在主窗口侧边栏（共享 sidecar）。
- 主窗口与快速窗口可同时收发各自会话的事件，互不串扰。

## 2. 用户决策摘要

| 决策点 | 选择 |
|---|---|
| 会话模型 | 每次显式「新建对话」才创建新 thread；Alt+L 仅 toggle 显示/隐藏 |
| 触发范围 | 系统全局快捷键（Electron `globalShortcut`） |
| 消失行为 | 仅 Esc / 再次 Alt+L 隐藏；失焦不自动隐藏；窗口实例常驻 |
| workspace 上下文 | 顶部紧凑选择器；切换即新建该 workspace 下的对话 |
| 渲染入口 | 单 Web 入口 + URL 参数 `?view=quick-input` 切换精简 Shell |

## 3. 架构总览

```
[Alt+L] → globalShortcut → toggleQuickInput()
                              │
              ┌───────────────┴────────────────┐
              ▼                                 ▼
   quickInputWindow (常驻, 默认隐藏)        mainWindow (不变)
   loadURL index.html?view=quick-input      loadURL index.html
              │                                 │
              └──────────┬──────────────────────┘
                         ▼
              App.tsx 按 ?view= 分流
              ├─ 无参数         → AppShell (现有, 含 healthcheck+boot)
              └─ ?view=quick-input → QuickInputShell (新, 跳过 healthcheck+boot)

              两者共享同一 sidecar (utilityProcess 单例)
              → 会话/消息天然同步; emitRendererEvent 同时广播两窗口
```

**核心思想**：子窗口只换「Shell」，不换运行时。`QuickInputShell` 装配与 `App.tsx` 相同的运行时依赖（jotai Provider / useGlobalAgentListeners / useWorkspaceBootstrap / TooltipProvider / Toaster），但绕过 healthcheck + boot screen，直接渲染 `AgentView`。

## 4. 主进程改动

涉及文件：`apps/desktop/src/main.ts`、`apps/desktop/src/electron-security.ts`、`apps/desktop/src/desktop-core.ts`、`apps/desktop/src/preload.ts`

### 4.1 globalShortcut 注册

- `app.whenReady().then()` 内，sidecar 启动后注册：
  `globalShortcut.register('Alt+L', toggleQuickInput)`
- 注册失败（返回 false，说明 Alt+L 被系统/其他程序占用）：`console.error` + `writeDesktopLogRecord` 记录，不中断启动。
- `app.on('will-quit')` 中 `globalShortcut.unregisterAll()`（现有 will-quit 只 stop sidecar，追加一行）。

### 4.2 quickInputWindow 生命周期

新增模块级变量 `let quickInputWindow = null`。

`createQuickInputWindow()`（参考现有 `wereadWindow` 与 `createMainWindow` 模式）：
- BrowserWindow 选项：`frame:false`、`show:false`、`skipTaskbar:true`、`alwaysOnTop:false`、`resizable:false`、`width:760`、`height:600`、`minWidth:520`、`minHeight:400`、`backgroundColor:'#111827'`、`icon:createWindowIcon()`、`webPreferences: createSecureWebPreferences({ preload: <同主窗口 preload 路径> })`
- 位置：水平居中，y = `screen.getPrimaryDisplay().workAreaSize.height / 3`（偏上）。
- `attachWebContentsSecurity(win, { allowNavigation })`：复用主窗口的安全策略，allowNavigation 同主窗口（限制到 app 协议 / dev server origin）。
- 加载：dev 态 `loadURL('${devServerUrl}/?view=quick-input')`；packaged 态 `loadURL('${APP_PROTOCOL_ORIGIN}/index.html?view=quick-input')`。
- `win.once('ready-to-show', () => { win.show(); win.focus() })`（首次创建由 Alt+L 触发，应给予焦点）。
- close 处理：`win.on('close', e => { if (!isQuitting) { e.preventDefault(); win.hide() } })` —— 复用现有 `isQuitting` 模式，让 `app.quit` 能真关闭。
- `win.on('closed', () => { if (quickInputWindow === win) quickInputWindow = null })`。
- dev 态不自动开 DevTools（避免每次唤起弹窗；调试时手动开）。

`toggleQuickInput()` 状态机：
1. `!quickInputWindow || isDestroyed()` → `createQuickInputWindow()`（ready-to-show 内 show+focus）。
2. `quickInputWindow.isVisible()` → `quickInputWindow.hide()`。
3. 否则（隐藏态）→ `quickInputWindow.show()` + `quickInputWindow.focus()`。

> 纯函数抽取：`computeToggleAction({ exists, visible }) → 'create' | 'hide' | 'show'`，放入 `desktop-core.ts` 便于单测（参考现有 `shouldHideToTrayCore` 模式）。

### 4.3 事件广播改造

`emitRendererEvent(channel, payload)` 改为遍历受信任窗口集合发送：

```ts
function emitRendererEvent(channel, payload) {
  for (const win of [mainWindow, quickInputWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(`lume:event:${channel}`, payload)
    }
  }
}
```

确保子窗口收到 `sidecar:event`（消息流）、`window-state` 等事件。

### 4.4 IPC 信任升级（关键安全改动）

`electron-security.ts` 中 `validateIpcSender` 当前只认 `mainWindow.webContents`，会拒绝子窗口所有 IPC。升级为接受受信任窗口集合：

```ts
export function validateIpcSender(event, trustedWindows) {
  const senders = (Array.isArray(trustedWindows) ? trustedWindows : [trustedWindows])
    .filter(Boolean)
    .map((w) => w.webContents)
  if (senders.length === 0) throw new Error('no trusted window available')
  if (!event || event.sender.isDestroyed?.()) throw new Error('untrusted ipc sender')
  if (!senders.includes(event.sender)) throw new Error('untrusted ipc sender')
  return true
}
```

所有现有 `ipcMain.handle` 调用点改为传入数组：
`validateIpcSender(event, [mainWindow, quickInputWindow])`。

### 4.5 新增命令 `quick_input_hide`

- `preload.ts` / `electron-security.ts` 的 `ALLOWED_RENDERER_INVOKE_COMMANDS` 加入 `'quick_input_hide'`。
- `main.ts` `dispatchCommand` 新增 case：`quickInputWindow?.hide()`（幂等，窗口不存在时返回 null）。
- 用途：渲染层 Esc 键隐藏窗口。

### 4.6 window-control 通道不动

`lume:window-control`（minimize/maximize/close）仍只操作 mainWindow。快速窗口不需要最小化/最大化；隐藏走 `quick_input_hide`，close 走窗口 close 事件拦截。避免改动现有通道语义。

## 5. 渲染层改动

涉及文件：`apps/web/src/App.tsx`、新增 `apps/web/src/components/quick-input/QuickInputShell.tsx`、`QuickInput.tsx`、`QuickInputWorkspaceSelector.tsx`

### 5.1 App.tsx 分流

在 `App` 组件顶部（healthcheck 之前）增加判断：

```ts
const isQuickInput = new URLSearchParams(window.location.search).get('view') === 'quick-input'
```

若 `isQuickInput`，直接 `return <QuickInputShell />`，跳过 `useState(ready)`、healthcheck、boot screen。理由：sidecar 已由主进程启动且为单例，子窗口加载时后端必然就绪或即将就绪；`sidecar_call` 失败时由 toast 兜底。

### 5.2 QuickInputShell.tsx

负责运行时装配，结构与 `App.tsx` 的 Provider 子树一致：

```tsx
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

### 5.3 QuickInput.tsx（状态容器）

职责：管理 threadId、workspace、Esc 监听、装配 hooks。

```tsx
export function QuickInput() {
  useGlobalAgentListeners()   // 订阅 sidecar:event, 投影到 atoms
  useWorkspaceBootstrap()     // 初始化 workspace 列表/默认值
  const [workspaceId, setWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [threadId, setThreadId] = useState<string | null>(null)

  // workspace 就绪后建首个会话。useWorkspaceBootstrap 首次启动时异步创建默认 workspace;
  // currentWorkspaceIdAtom 为 atomWithStorage, 老用户有持久化值则立即可用。
  // 必须等 workspaces 列表就绪, 否则首会话会落空 workspace。
  const workspaces = useAtomValue(agentWorkspacesAtom)
  useEffect(() => {
    if (threadId || workspaces.length === 0) return
    createThread(workspaceId ?? workspaces[0]?.id ?? undefined).then(setThreadId)
  }, [workspaces.length])  // 列表就绪后触发一次

  // Esc 隐藏窗口
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') electronAPI.invoke('quick_input_hide') }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  const handleNewThread = () => createThread(workspaceId ?? undefined).then(setThreadId)
  const handleWorkspaceChange = (id: string) => {
    setWorkspaceId(id)
    createThread(id).then(setThreadId)   // 切换即新建, 保持选择器=当前会话 workspace
  }

  return (
    <div className="h-screen w-screen flex flex-col ...">
      <header className="-webkit-app-region: drag ...">
        <QuickInputWorkspaceSelector value={workspaceId} onChange={handleWorkspaceChange} />
        <button onClick={handleNewThread}>新建对话</button>
      </header>
      <main className="flex-1 min-h-0">
        {threadId ? <AgentView threadId={threadId} /> : <div className="flex-1 grid place-items-center text-muted-foreground">…</div>}
      </main>
    </div>
  )
}
```

**复用 `AgentView` 而非裸 `AgentInput`**：因为 `AgentView` 已用 `ThreadFileEnvProvider` 包裹，提供 `@文件` 链接、源码预览等所需 context，并自带 `AgentMessages` + `AgentInput` + 权限/询问覆盖层。

### 5.4 QuickInputWorkspaceSelector.tsx

紧凑下拉（基于 base-ui Select，参考 `WorkspaceSelector.tsx` 现有实现），数据来自 `agentWorkspacesAtom`。注意 base-ui SelectValue 需显式传 children 显示 label（见项目 memory：base-ui SelectValue 陷阱）。

## 6. 数据流

```
新建会话: createThread(workspaceId) ──sidecar CREATE_THREAD──> thread ─> setThreadId ─> AgentView
发消息:   AgentInput.handleSend ──> agentSend({threadId,...}) ──sidecar SEND_THREAD_MESSAGE──> runtime
响应回流: sidecar runtime event
          ─> main.emitRendererEvent('sidecar:event', ...) 广播 mainWindow + quickInputWindow
          ─> 两窗口各自的 useGlobalAgentListeners
          ─> agentRuntimeEventsFamily(threadId)
          ─> AgentMessages 重渲染
主窗口同步: 同一 sidecar event 也进主窗口 listeners
            ─> agentThreadsAtom / MESSAGE_APPENDED
            ─> 主窗口侧边栏出现快速会话
```

## 7. 交互细节

| 项 | 值 |
|---|---|
| 尺寸 | 760 × 600（min 520 × 400），`resizable:false` |
| 位置 | 水平居中，y ≈ 屏幕工作区高度的 1/3（偏上，spotlight 风格）|
| 边框 | `frame:false`；渲染层自绘圆角 + 顶部拖拽区（`-webkit-app-region: drag`，参考 `app-region.ts`）|
| 任务栏 | `skipTaskbar:true`（辅助窗口，不占任务栏位）|
| 置顶 | `alwaysOnTop:false`（尊重「可参考其他窗口」的意图）|
| Esc | 渲染层 keydown → `invoke('quick_input_hide')` → 窗口 hide |
| 失焦 | 不自动隐藏 |
| Alt+L | toggle：显示↔隐藏；窗口不存在则创建 |

## 8. 错误处理

- `createThread` 失败 → sonner toast「创建会话失败」，threadId 保持 null，主体显示重试占位。
- `agentSend` 失败 → AgentInput 现有错误处理 + toast。
- sidecar 未就绪 → 因绕过 healthcheck，首次 `sidecar_call` 会抛错 → toast「后端未就绪，请稍候」；不无限重试。
- `globalShortcut.register` 返回 false → 记录 desktop log，启动继续；主窗口不弹窗（避免干扰）。
- 子窗口崩溃/被销毁 → `on('closed')` 置 null，下次 toggle 重建。
- 主进程 `dispatchCommand('quick_input_hide')` 在 quickInputWindow 为 null 时静默返回 null（幂等）。

## 9. 测试策略（沿用现有 vitest）

- **desktop-core.ts 纯函数**
  - `computeToggleAction({exists, visible})` → 三种返回值覆盖。
  - 快速窗口 BrowserWindow 选项构建函数（如 `createQuickInputWindowOptions()`）→ 断言 frame/skipTaskbar/尺寸等关键字段。
- **electron-security.ts**
  - `validateIpcSender(event, [mainWin, quickWin])`：接受两窗口的 webContents、拒绝未知 sender、空数组抛错。
- **QuickInput.tsx**
  - 挂载调用 `createThread` 一次并 setThreadId。
  - 「新建对话」按钮 → 再次 `createThread`，threadId 更新。
  - workspace 切换 → `setCurrentWorkspaceId` + 新建 thread。
  - Esc → `electronAPI.invoke('quick_input_hide')` 被调用（mock electronAPI）。
- **集成**：globalShortcut 与真实窗口的端到端验证靠手动 QA（按下 Alt+L 观察），不写自动化。

## 10. 范围边界（YAGNI — 明确不做）

- ❌ 快捷键自定义（硬编码 Alt+L；冲突时仅记日志，后续按需加设置项）。
- ❌ 窗口 resizable（先固定尺寸）。
- ❌ alwaysOnTop 切换、失焦自动隐藏配置（当前选择不需要）。
- ❌ 独立 vite HTML 入口（单入口足够）。
- ❌ 快速窗口内的文件浏览、阅读、设置等其他视图（只做对话）。
- ❌ 快速窗口自定义标题栏按钮（无框但只保留拖拽区 + workspace 选择器 + 新建按钮，无最小化/关闭按钮，靠 Esc/Alt+L 关）。

## 11. 关键文件清单

改动：
- `apps/desktop/src/main.ts` — globalShortcut、createQuickInputWindow、toggleQuickInput、emitRendererEvent 广播、dispatchCommand 新增 case、validateIpcSender 调用点改数组
- `apps/desktop/src/electron-security.ts` — `validateIpcSender` 升级为窗口数组
- `apps/desktop/src/desktop-core.ts` — 抽 `computeToggleAction` 等纯函数
- `apps/desktop/src/preload.ts` — `ALLOWED_RENDERER_INVOKE_COMMANDS` 加 `quick_input_hide`
- `apps/web/src/App.tsx` — `?view=quick-input` 分流

新增：
- `apps/web/src/components/quick-input/QuickInputShell.tsx`
- `apps/web/src/components/quick-input/QuickInput.tsx`
- `apps/web/src/components/quick-input/QuickInputWorkspaceSelector.tsx`

## 12. 风险与权衡

- **Alt+L 系统冲突**：Windows 上 Alt+L 可能被输入法或全局快捷键占用，导致 `register` 返回 false。缓解：日志记录；未来加设置项（已在范围边界声明）。
- **绕过 healthcheck 的代价**：若 sidecar 启动失败，快速窗口首次发消息才暴露错误。可接受（主窗口会显示完整错误页，且快速窗口本身依赖主进程已启动 sidecar）。
- **emitRendererEvent 广播开销**：两窗口都收到所有 sidecar 事件，但 listeners 内部按 threadId 过滤，无实质性能问题。
- **IPC 信任集合扩大**：子窗口获得与主窗口几乎相同的 invoke 权限（sidecar_call、clipboard 等）。可接受，因两者加载同一受信 preload + 同源，且子窗口同样受 CSP / allowNavigation 约束。
