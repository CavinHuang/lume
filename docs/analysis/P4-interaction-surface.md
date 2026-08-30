# ZCode 桌面端 SidePane 外部交互面 — 补缺报告

对象：`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 字节）+ `out\main\index.js`。新切片存于 `D:\tmp\zc-analysis\out\sidepane\X1~X29`。偏移均为原始文件字节偏移。

---

## 缺口 1：Chat → SidePane 的全部打开路径

### 1a. agentSummaryAction "Open on the right" — 打开的是 subagent-session（不是 model-trajectory）

**构造点**（@2068945 `d6e`，子代理工具行组件）：
```js
s = (0,Q.useCallback)(() => {
  Bk({ input: { featureId: `conversation.subagent`, action: `open_side_pane`, trigger: `button` },
       operation: () => u6e({ childSessionId: r, context: t, subagentType: i, title: a }),
       completed: { resultSource: `local_commit` }, failureStage: `subagent_open` })
}, ...)
c = o && r ? { onActivate: s, testId: vo(pre, r) } : void 0   // r = childSessionId
// xZ 收到 agentSummaryAction: c
```
**payload**（@2068740 `u6e`）：
```js
o({ rootSessionId: n.rootSessionId ?? a, parentSessionId: a, childSessionId: t, subagentType: r, title: i })
```
**渲染**（@1819699 `LQe`）：有 `action` 时整个 summary 行变 `role="button"`，`onClick: t.onActivate`、`aria-label: t.ariaLabel`（i18n `chat.toolCall.agent.openInSidePane` = "Open on the right"，@1944965），此时该行不可再展开详情（`B=F!==void 0` 关闭折叠）。

**落地**（@214020 `Qde` 内 @2178xx `ce` = handleOpenSubagentSession）：
```js
n = e.rootSessionId ?? e.parentSessionId;
b(!1);                                    // 强制展开（清除 collapsed）
P(r => vde(r, { workspaceKey, workspacePath, rootSessionId: n, parentSessionId,
               childSessionId, subagentType, title }));   // → subagent-session tab
D.current.set(n, i.activeTabId)           // rootSessionId→tabId 记忆，供切换回对话时自动激活
```
结论：**"Open on the right" 只由点击触发**（`u6e` 全文仅 1 个调用方），无后台子代理自动弹开；`backgrounded` 参数在此路径未用。

### 1b. model-trajectory 是另一条链：标题栏菜单 → 请求总线
- zustand 总线 @210109：`Nd`，`window.__zcodeModelTrajectoryStoreE2E`（E2E 钩子），`requestOpen({taskId, workspaceKey, title})` 生成 `requestId: "model-trajectory-open:N"`。
- 调用方仅 2 处，均为**头部菜单**（`onViewModelTrajectory`，紧邻 `appHeader.copySessionId`）：@2873697（当前对话头 Xht）与 @3089279（任务列表项头）。
- 消费方：Qde 内 @210464 `Ide(workspaceKey, se)` 订阅 pendingRequest，workspaceKey 匹配才消费并调 `se`（@219132 `handleOpenModelTrajectory`，`pde` reducer → `model-trajectory` tab，需 `e.taskId`）。跨 workspace 的请求不会误开。

### 1c. 浏览器导航请求（browserNavigationRequest）
`Qde` 中 `z` = handleOpenBrowserUrl（@216638）：
```js
if (!u) { window.open(e, `_blank`, `noopener,noreferrer`); return }   // 无内嵌壳
let n = `browser:${io()}`;
w({ id: io(), targetTabId: n, url: e })      // setBrowserNavigationRequest
b(!1); P(t => _d(t, { tabId: n, initialUrl: e }))  // 开/激活 browser tab
```
即 navreq 与开 tab 同步发出，`{id, targetTabId, url}`；webview 挂载后导航并回调 `handleBrowserNavigationRequestHandled`（`Te`：`w(t => t?.id === e ? null : t)`）清空。来源：聊天内 website 链接（`p6e` @2070162 `e.type === 'website' → t?.(e.url)`）；side-pane webview 内 window.open 经 platform `l.onOpenBrowserUrl` → 再走 `z` 新开 tab（@216756）。切 workspace 时 `Fjt`（@3871560）清空 navreq。

### 1d. 工具调用自动开面板：browser-use 的"挂载/揭示"模型
platform 事件驱动（@2167xx 起）：
- `onBrowserViewReady → ee`：`lde(state, e, scope)` 返回 `{state, shouldReveal}`；`shouldReveal ? 展开(b(!1)) : 后台挂载`，日志 `"展开并激活"/"后台挂载" browser-use tab`。
- `onBrowserViewOperation`：`kde` 写 `browserUseOperationUntil = Date.now()+5000`（`zue=5e3`）操作锁。
- `onBrowserViewVisibility`：`ude` 命中现存 tab 则 `A.current.set("workspaceKey::sessionId", "browser-use:tabId")` 并揭示；不可见且激活的是该 browser-use tab 则**自动收起**（`b(!0)`）。
- `onBrowserViewCloseTab/Suspend/Restore`：跨 workspace 的关闭直接改缓存（`Ad/jd`）；suspend/restore 写 `residency`。
其余工具调用（file read/write、shell 等）只展开行内详情，**不开面板**；`autoOpen` 仅为行内折叠状态。

---

## 缺口 2：标题栏 / 窗口 chrome

- **按钮组件** `qht`（@2864171）：标题栏右侧按钮组，与编辑器选择器（`Kht`）、终端 toggle（`l3`）并列。侧面板按钮：
```js
Tooltip { id:`sidePane.togglePanel`, side:`bottom`, shortcut:c }   // c = toggleSidePaneShortcutLabel
Button ghost icon-md, className: `text-foreground hover:bg-hover hover:text-foreground`
  + (f && `h-full w-[var(--windows-caption-control-width,46px)] rounded-none`)  // Windows titleBarOverlay 融合
  + (a && `!bg-selected text-foreground`)        // 打开态高亮
aria-label: a ? `sidePane.collapse` : `sidePane.expand`;  onClick: s   // onToggleSidePane
icon: m = a ? lce : uce    // panel-right-close-BzS6w9yt.js / panel-right-open（@72484 导入）
```
- **语义**：标题栏按钮与快捷键走的都是 `Cn = () => Je()`（L 切片 @3884388），`Je = handleToggleSidePaneCollapse = b(e=>!e)`（X20 @22270x，日志 `[App] 收起/展开右侧面板`）——**是 collapse 切换，非关闭**；面板用 `PAt`（@3826130，`collapsedSize:'0px'`，`rememberExpandedSize` 存 ref）保持挂载。无独立"关闭面板"chrome 按钮；关闭靠 tab 上的 close。
- **★修正 P1 结论：存在侧面板快捷键**。全局 keydown `bme`（@295657）实际包含：
```js
if (Jo(e,`b`)) { …; r(); return }        // Cmd/Ctrl+B 侧栏
if (Jo(e,`j`)) { …; i(); return }        // Cmd/Ctrl+J 终端
if (lse(e,`b`)) { e.preventDefault(), a(); return }   // ← Cmd/Ctrl+Alt+B = toggleSidePane
```
`lse` = `keyboardShortcuts-CZbTLYDw.js` 导出 `c`（@66110 导入 `c as lse`）= `p(e,n) && e.altKey`（mod+alt 匹配）。App 接线 @3893196：`bme({…, toggleSidePane: () => wn(Cn), …})`。
- **快捷键标签来源**（App 头 @3882593）：`let R=Ko('B'), z=Ko('N'), B=Ko('['), V=Ko(']'), ee=Ko('J'), te=pse('B'), …`；`pse` = 同 chunk 导出 `t`：mac 输出 `⌥ ⌘ B`，win 输出 `Ctrl+Alt+B`——与实际 handler 一致。
- 移动端/远程壳（@2836036）：面板变 slide-over（`w-[min(88vw,28rem)]` translate-x），全屏遮罩按钮 aria-label=`sidePane.collapse`。
- 尺寸配置 `tAt`（@2051xxx 文件 R5）：桌面 `minSize:'240px', maxSize:'65%', useResizablePanel:true`；mobileOverlay 全宽不可拖。

---

## 缺口 3：持久化（确认：右侧面板状态**不落盘**）

- **唯一存储**：模块级 Map `Dd`（@209120）：`Ed = { sidePaneState:null, isSidePaneCollapsed:true, activeGitSourceId:'unstaged', browserUrls:{}, browserUrl:null }`；`kd` 键 = `workspaceIdentity?.trim() || workspacePath`；`Ad` 读（经 `sd()` 消毒）、`jd` 写、`Fde` **LRU 上限 50 个 workspace**。任务/workspace 切换经 `jd(e, M.current)` 存、`Ad(p)` 取（Qde @214046 useEffect）——**仅 renderer 内存，reload 即失**；浏览器 tab 重开时还会换新 id（`we`：`{...i, id:'browser:'+io()}`）。
- **localStorage 全量排查**（9 set / 11 get 全部核过）：只有左栏宽度 `ijt = 'zcode:workspace-shell:sidebar-width-px'`（`G8/gjt` 读写，`W8` 夹紧 264px..innerHeight×0.5，常量 @3828860）、react-resizable-panels 快照 `ajt = 'react-resizable-panels:workspace-shell-layout:sidebar:content'`（左栏分组，全项目唯一持久化分组）、split-pane `crt='zcode-v4-pane-layout:v2'`/`lrt=…v1`（`o1` 分屏 store，非右侧面板）、last-session、client-id、theme、locale。**无任何 sidePaneState/collapsed 的写盘，也无 IPC 持久化**。
- 右侧面板宽度：`PAt` 只把展开尺寸记在 `useRef`（`${t}%`），会话内有效；`react-resizable-panels:` 无右面板分组（`workspace-shell-layout` 仅 1 处出现）。
- 最近关闭 tab 栈：`Xde = 8`（@213793），`ye` 明确排除 `selection-side-chat` 与 `browser-use` 不进重开历史。

---

## 缺口 4：多窗口

- **renderer 内 `windowId` 出现 0 次**。所有 pane 状态（`Dd` Map、zustand store）都在各窗口自己的 JS 上下文中——**天然 per-window**，每窗口一份 App/Qde 实例。无 BroadcastChannel、无 storage 事件同步（唯一 `addEventListener('storage')` @3797644 只监听 `zcode:developer-tools:enabled`/`token-debug` 调试开关）。
- **主进程**（out/main/index.js）确认支持多主窗口：`createBrowserWindow`（@1261607，`webviewTag:true`）→ 包装器以 `` `local-${webContents.id}` `` 为窗口键（@1301xxx），`getMainApplicationWindows` 返回复数集合（@1472xxx `i$()`）；每窗口独立 host 进程映射 `windowHostProcessMap`（按 webContents.id）。
- **windowId 唯一起作用的地方**：`BrowserTabResidencyCoordinator`（@922700，类 `Gg`）——main 侧按 `windowId` 分组跟踪 browser-view tab（每窗口 `tabLimit ?? 32`，`xH` 选驱逐受害者；residency 状态机 live-visible/live-background/suspend-pending/restoring/suspended）。即：**tab 列表在 renderer、per-window；tab 的 WebContents 驻留预算在 main、按 windowId**。renderer 的 `browserViewEnsureResident/browserViewCloseTab` 调用只传 `{tabId, workspaceKey, remoteSessionId, sessionId}`，windowId 由 main 从 sender 解析。

---

### 关键修正与结论速览
1. P1 "无侧面板快捷键" 不成立：`bme` 中 `lse(e,'b')` = **Cmd/Ctrl+Alt+B** 切换右侧面板（与标题栏 tooltip 标签 `pse('B')` 一致）。
2. "Open on the right" 打开 **subagent-session** tab（payload：root/parent/childSessionId + subagentType + title），点击触发；**model-trajectory** 由头部菜单经 `Nd` 请求总线打开，二者是不同面板。
3. 右侧面板状态 100% renderer 内存（50-workspace LRU Map），唯一 chrome 持久化是**左侧**栏宽 `zcode:workspace-shell:sidebar-width-px`。
4. 副屏状态 per-window（renderer 上下文隔离）；main 仅按 windowId 管理 browser tab 驻留（每窗 32 上限）。