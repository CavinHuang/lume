# Agent 灵动岛（Agent Island）设计

- **日期**：2026-08-04
- **目标**：在 Lume 复刻 Proma 的"灵动岛"（Agent Island）——一个跨应用环境感知的悬浮状态面，让 agent 运行态、待交互、紧迫规划在主窗口不可见时仍可被感知。
- **参考实现**：Proma `apps/electron/src/main/lib/agent-island-*.ts` + `apps/electron/src/renderer/components/agent-island/`，类型契约参考 Cindy (makecindy/cindy) 的 Agent Island。
- **范围决定**：完整复刻，含 macOS 26+ 原生刘海路径（Swift），全层详设。
- **核心决策**：渲染面 = 系统级悬浮窗（方案 A：主进程岛屿 service）；macOS<26 / 非 macOS 走 Electron 透明窗；内容 = agent 运行态 + planning（todos / 日历提醒），**不含渠道额度**（Lume 无此数据源）。

---

## 1. 架构与组件映射

### 1.1 进程模型（方案 A）

Lume 是 `sidecar → main → renderer` 三段。岛屿是**独立 renderer 进程**（系统级悬浮窗），与主窗口不共享 Jotai 状态。因此状态真源放在 `apps/desktop` **主进程**：

```
sidecar ──事件流──▶ apps/desktop main ──IPC push──▶ 岛屿 BrowserWindow（独立 renderer）
                   (agent-island-service:                 AgentIslandApp（无状态展示）
                    订阅 + 投影 + 节流)                        │
                        │                                    └─ intents ─▶ main
                        ├── macOS 26+ ─▶ Swift NSPanel（消费同一快照，JSONL）
                        └── 其他 ─▶ Electron 透明窗
```

- 主进程**已经在**转发 sidecar 事件给 renderer（`listen('sidecar:event')`），岛屿 service 是对同一流的零成本 tap。
- 主窗口的 `apps/web`（含现有 Jotai atoms）**完全不动**。岛屿与主窗口解耦——主窗口关掉/最小化时岛屿照常工作（环境感知的核心）。
- 主进程的岛屿投影逻辑与 renderer 的 `useGlobalAgentListeners`（per-thread 落 atom）**目的不同**：后者服务主窗口 UI，前者服务悬浮窗的跨 thread 选主导 + 投影。非重复劳动。

### 1.2 文件清单

```
packages/shared/src/types/agent-island.ts        类型契约（唯一真源）
apps/desktop/src/main/
  ├ lib/agent-island-service.ts     ★ 状态机：订阅 sidecar 事件流 + 投影快照 + 节流推送
  ├ lib/agent-island-window.ts      Electron 透明置顶窗（位置/尺寸钳制/层级）
  ├ lib/mac-agent-island-native-host.ts  spawn Swift 二进制 + JSONL stdio + 4s 超时回退
  ├ lib/agent-island-planning.ts    todos/reminders 紧迫度选择器
  ├ lib/agent-island-projections.ts ★ 纯函数投影（phase映射/选主导/buildKey/projectPlanning/buildSnapshot）
  └ lib/macos-version.ts            isMacOS26OrLater() 门槛
  + main/index.ts 初始化/拆卸接线；ipc.ts 注册 handler
apps/web/src/components/agent-island/
  ├ AgentIslandApp.tsx    根组件：订阅 onState、测展开高度、渲染 compact 层 + expanded 卡片
  └ agent-island.css      布局 + CSS 过渡（无动画库）
  + main.tsx 识别 ?window=agent-island 查询参数，惰性挂载 <AgentIslandApp/>（独立入口，复用同一 bundle）
apps/desktop preload：暴露 window.__lumeDesktopBridge__.agentIsland.*
packages/shared settings：AgentIslandSettings { enabled?: boolean }，默认 true（写入 lume-config.ts）
packages/natives：新增 Swift target（macos-agent-island-helper）
```

### 1.3 数据源映射

| 岛屿字段 | Lume 数据源 | 获取方式 |
|---|---|---|
| session phase / detail / activityLines | sidecar `RUNTIME_EVENT` / `RUNTIME_STATUS_CHANGED` | main tap 事件流 |
| session title | sidecar agent session meta | `sidecarCall` |
| 待交互（permission / ask_user / desktop_action） | `TOOL_PERMISSION_REQUEST` / `ASK_USER_QUESTION` / `DESKTOP_ACTION_REQUEST` | 同事件流 |
| 紧迫 todos | `listPlanningTodos` + `PlanningTodo` | `sidecarCall` + `onPlanningTodoChange` |
| 日历/提醒 | `listActivePlanningReminders`（`targetType:'calendar_event'`） | `sidecarCall` + `onPlanningRemindersDue` |
| 空闲最近会话 | `listAgentSessions` | `sidecarCall` |
| ~~渠道额度~~ | **Lume 无** → 不渲染额度轮播 | — |

### 1.4 关键设计纪律

- **投影逻辑抽纯函数**（`agent-island-projections.ts`）：`mapRuntimePhaseToIslandPhase` / `selectPrimarySession` / `buildVisibilityKey` / `projectPlanning` / `buildSnapshot`。service 只剩薄订阅壳。这让 90% 逻辑在 Windows 可单测（Proma 把这些混在 974 行 service 里，难测——Lume 主动改进）。
- **Swift 侧零业务状态**：所有 phase 推导 / 选主导 / dismiss 哈希 / 节流都在 TS service。Swift 只渲染收到的快照 + 回传意图。
- **两渲染面消费同一 `AgentIslandState`**：macOS 原生面是 Electron 面的"再接一个消费者"，零返工。

---

## 2. 状态机与数据流

### 2.1 双正交状态机

**`phase`（内容/色，由 agent 事件驱动）**
```
idle → running → needs-interaction → running → completed → (10min 后剔除)
                 ↑↓                    ↘ error
```

**`presentation`（尺寸，由指针驱动）**
```
hidden ↔ compact ↔ expanded
```
- `isExpanded = manuallyExpanded || hoverExpanded`
- 点击收起条 → 展开；点击头部"收起" → 显式收起（覆盖当前 hover）。
- 悬停防抖：`pointerHovered` 立即更新（高亮反馈）；`hoverExpanded` 延迟——展开 `130ms`、收起 `420ms`。
- renderer 本地 `SurfaceMode = 'compact' | 'expanded' | 'collapsing'`，`collapsing` 在回到 compact 前保留旧内容（配合 180ms 过渡）。

### 2.2 Lume 事件 → 岛屿 phase 转换

**相对 Proma 的简化**：Proma 在主进程解析原始 `agentEventBus` 推 phase；Lume 的 sidecar 已算好 `RUNTIME_STATUS_CHANGED`（携带 per-thread `AgentRuntimePhase`），main 直接订阅即可。

| Lume 信号 | 岛屿 phase | interactionKind |
|---|---|---|
| `RUNTIME_STATUS_CHANGED` → `streaming` | running | — |
| `RUNTIME_STATUS_CHANGED` → `compacting` | running（detail="压缩上下文"） | — |
| `TOOL_PERMISSION_REQUEST` | needs-interaction | permission |
| `ASK_USER_QUESTION` | needs-interaction | ask_user_question |
| `DESKTOP_ACTION_REQUEST` | needs-interaction | **desktop_action**（Lume 特有扩展） |
| `awaiting_*` 解决 | running | — |
| run completed (success) | completed（unread, 设 terminalAt） | — |
| run failed / `errored` | error | — |
| `idle` | idle | — |

`AgentRuntimePhase` ↔ 岛屿 phase 由纯函数 `mapRuntimePhaseToIslandPhase()` 完成。

### 2.3 主导会话选择（多 thread 聚合）

Lume 是多层递归线程树。聚合策略：
- **按顶层 thread 聚合**：父 thread 有活跃子代理运行 → 整体视为 running，detail 反映子代理活动（避免子代理淹没岛屿）。
- **优先级排序**（决定 primary 与最多 3 条展示）：`needs-interaction > running > completed(unread) > error`，同级按 `lastActivityAt` 降序。
- `primarySessionId` = 排序首位；`compactLabel` = `Lume · ${PHASE_LABEL[primary.phase]}`（或紧迫规划标签、或空闲"工作提醒"）。

### 2.4 快照构建与节流

`buildState()` 组合 sessions Map + planning 投影 → `AgentIslandState` → `pushState()`：

| 内容 | 节流 |
|---|---|
| 紧迫（permission/ask_user/desktop_action/result/error/planning） | `PUSH_THROTTLE_MS = 80ms` |
| 普通 token/tool 流 | `AGENT_STREAM_PUSH_THROTTLE_MS = 2000ms` |
| planning 变更 | 绕过节流，`pushPlanningStateImmediately()` |
| 去重 | 与上次推送 JSON 相同则跳过（`lastStateJson`） |

activityLines 每会话上限 `MAX_PUSHED_ACTIVITY_LINES = 4`。

### 2.5 可见性与 dismiss

- **`isIslandVisible()`** 为真当：有活跃会话 **或** 紧迫规划（todo 1h 内到期 / 日历 1h 内开始 / 已逾期）**或** 空闲仪表盘模式。
- **dismiss**：`buildVisibilityKey` 哈希 `(sessionId:phase:lastActivityAt:detail | planningKeys)`；用户 dismiss → 存该 key；**key 不变保持隐藏**，变化（新事件/新紧迫项/跨日）才重现。
- 跨日：`scheduleNextPlanningRollover` 在 00:00:00.150 增 `planningRevision`、清 dismiss。
- 紧迫度调度：`scheduleNextPlanningAttention` 算下一个 todo-due/event-start ± `1h`，到窗口即浮现。
- 终态会话保留 `UNREAD_RETAIN_MS = 10min`；running 会话 24h 无活动剔除。

---

## 3. UI / 视觉

### 3.1 窗口与定位（`agent-island-window.ts`）

```
BrowserWindow: frame:false / transparent:true / alwaysOnTop:true
               skipTaskbar:true / hasShadow:false / backgroundColor:#00000000
默认 420×32px；宽度钳制 320–620，高度 32–640
位置：水平居中于光标所在显示器
      macOS 垂直 = bounds.y（贴刘海/菜单栏）
      Windows/Linux 垂直 = workArea.y + 12px
层级：macOS 'pop-up-menu' / Windows 'screen-saver'
非 win32：setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true })
```

### 3.2 DOM 与动画（`agent-island.css`，纯 CSS 无动画库）

```
.island-root        flex 居中、填满窗口
.island-surface     position:relative / width:420px / height: 32px ↔ var(--island-expanded-height)
                    bg:#09090a / box-shadow: 0 8px 24px rgb(0 0 0/.32)
.island-transition-surface  transition: height 180ms cubic-bezier(0.2,0,0,1)   ← SURFACE_TRANSITION_MS=180
展开内容交叉淡入        transition: opacity 90ms ease-out / transition-delay: 45ms
compact 层展开时淡出    同 90ms / 45ms
点击行                 transform: scale(0.985)
@media (prefers-reduced-motion: reduce)  禁用全部过渡
```
renderer 用 `useLayoutEffect` 测展开内容真实高度，经 IPC 回写 `--island-expanded-height`。

### 3.3 形态分叉

- **macOS**：`border-radius: 0 0 18px 18px`（无上边框，融入菜单栏/刘海）。
- **Windows/Linux**：`border-radius: 0` + 四边 1px 边框矩形条（忠实复刻 Proma）。

### 3.4 Compact 胶囊内容（420×32）

```
[●phase 色点] Lume · {阶段标签}  [紧迫图标]  · 第 N 步 · toolName  · 队列 M  [▾]
```
- 阶段标签：`正在执行` / `需要你接手` / `任务完成` / `执行出错` / `压缩上下文`。
- 紧迫图标（仅当 planning 有 1h 内项）：`Bell` / `ListTodo` / `CalendarDays`。
- running 才显示 `第 N 步 · toolName`；有队列才显示 `· 队列 M`。
- 无额度摘要。

### 3.5 Expanded 卡片内容

```
┌─ 眉题 ────────────────  [打开 Lume] [收起] ─┐
│ {标题：正在执行 / 需要你接手 / 任务完成 / 执行出错} │
├─────────────────────────────────────────┤
│ 会话行 ×≤3（点击 → openSession）             │
├──────────────────┬──────────────────────┤
│ 紧迫 Todos       │ 日历/提醒             │
└──────────────────┴──────────────────────┘
```
**空闲模式**（无活跃会话时展开）：用**最近会话 ×≤3**（`listAgentSessions`，点击恢复）+ planning 替代额度轮播。

### 3.6 主题策略（已定：A）

表面**恒定深色** `#09090a`，不跟随 Lume 亮/暗主题与多调色板（与 Apple 灵动岛一致，环境感）。phase 色取自 token：`--lume-accent`(运行) / `--lume-warning`(待交互·中断) / `--lume-success`(完成) / `--lume-danger`(错误)。

### 3.7 与 AGENTS.md 原子规则

岛屿是自定义 morphing 表面，容器/胶囊/变形过渡按 Proma 手写 CSS（无对应原子）。其中交互控件（按钮、弹层）使用 `apps/web/src/components/ui` 的 shadcn `Button` 等，不手写完整按钮样式。

---

## 4. Swift 原生刘海面

> **约束**：macOS 原生代码，Windows 开发机无法编译/验证。Swift/NSPanel API 精确签名需在 macOS 26 SDK 实现时核对。下文区分"可确定的设计契约"与"需在 macOS 确认的 API"。

### 4.1 渲染面路由（`main/index.ts`）

```
startAgentIslandSurface():
  if !settings.agentIsland.enabled: return
  if isMacOS26OrLater():
    start native host（4s ready 超时）
      on {type:'ready'}  → 用原生面，不创建 BrowserWindow
      on 超时 / {type:'fatal'} / 进程退出  → 回退 Electron 透明窗
  else (macOS<26 / Windows / Linux):
    直接创建 Electron 透明窗
```

> **偏离 Proma**：Proma 在 macOS<26 时整岛禁用。Lume 改为 macOS<26 走 Electron 浮动窗（与非 macOS 一致），不丢失这部分用户。逻辑无额外成本。

### 4.2 Native host 生命周期（`mac-agent-island-native-host.ts`）

- 仅在 `isMacOS26OrLater()` 为真时 spawn。
- spawn `macos-agent-island-helper`，stdio 管道；向 stdin 写 JSONL 快照（行分隔，复用 service 推送节流）；逐行读 stdout。
- 4s 内未收到 `{type:'ready'}` → kill + 回退 Electron 窗。
- 收到 `{type:'fatal'}` 或进程 exit → 回退 Electron 窗。
- 应用关闭时 dispose（kill 子进程）。
- outbound `intent` 交给 `handleNativeAgentIslandEvent`，**与 Electron renderer 的 intent 走同一组 handler**。

### 4.3 JSONL 协议契约（`packages/shared` 定类型）

**Inbound（main → Swift），行分隔 JSON：**
```json
{ "type": "snapshot", "state": <AgentIslandState>, "window": { "presentation": "compact"|"expanded" } }
```
- `expandedHeight` **不入站**：原生面自测内容高度定 NSPanel frame（Electron 路径靠 renderer 回传，两路径行为差）。

**Outbound（Swift → main）：**
```json
{ "type": "ready" }
{ "type": "intent", "name": "set-expanded",  "value": true }
{ "type": "intent", "name": "set-hovered",   "value": true }
{ "type": "intent", "name": "open-main" }
{ "type": "intent", "name": "open-session",  "threadId": "..." }
{ "type": "intent", "name": "open-planning" }
{ "type": "intent", "name": "dismiss" }
{ "type": "fatal",  "message": "..." }
```

### 4.4 Swift NSPanel 渲染（`packages/natives` 新增 target）

**面板配置（可确定）：**
```
NSPanel: styleMask = .borderless
         isOpaque = false, backgroundColor = .clear
         level = .statusBar（覆盖菜单栏/刘海之上）
         collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
         becomesKeyOnlyIfNeeded = true，非激活（不抢 app 焦点）
         hasShadow = true（面板自绘阴影）
```
**内容**：`NSHostingController` 承载 SwiftUI 视图，镜像岛屿（compact pill / expanded card），同 `#09090a` 表面 + 180ms 形变（`withAnimation`），phase 色同套色值。

**刘海锚定（需在 macOS 26 SDK 核对）：**
- 定位策略：面板水平居中、垂直贴顶，覆盖刘海区域。
- macOS 12+ 有 `NSScreen.safeAreaInsets` 反映刘海高度；macOS 26 可能新增更直接的 notch 几何 API。
- **待确认**：精确"取刘海矩形"API 名与版本门槛，以 macOS 26 SDK 文档为准。

**意图**：SwiftUI 视图的点击/悬停手势 → 序列化为 outbound `intent`。Swift 不持有任何业务状态。

### 4.5 构建与打包

- Swift 二进制经 `xcodebuild`/SwiftBuild 产出 **universal binary**（arm64 + x86_64），打包进 macOS app resources。
- `packages/natives` 新增 Swift target。**构建仅能在 macOS 完成**；CI 需 macOS runner。
- Windows 开发机只开发/验证 Phase 1（Electron 面）。

---

## 5. 错误处理 / 边界 / 设置 / 共存

### 5.1 错误处理

| 场景 | 处理 |
|---|---|
| native host 4s 未 ready / `{fatal}` / exit | 回退 Electron 窗（§4.2），记日志 |
| 岛屿 BrowserWindow 意外关闭/crash | main 检测 → 重建窗口（状态在 service，不丢） |
| sidecar 断连 | 岛屿进入 `连接中断` 暗态（dim + 标签），保留最后已知快照；重连恢复。复用 Lume 现有连接状态信号 |
| 事件洪峰 | 80ms/2000ms 节流 + `lastStateJson` 去重 |
| app 启动早于 sidecar | 无事件 → idle，自然恢复 |

### 5.2 边界

- **多显示器**：跟随光标所在显示器；显示器配置变化时重定位。
- **dismiss 后新紧迫项**：visibility key 变化 → 重现。
- **队列中断**：`agentQueueInterruptedFamily` → detail 显示"中断" + warning 色。
- **子代理**：聚合进父 thread，不单独占位。
- **终态/僵尸会话清理**：completed/error 保留 10min（unread），running 24h 无活动剔除。

### 5.3 设置

- `AgentIslandSettings { enabled?: boolean }`，默认 true，写入 `lume-config.ts`。
- `GeneralSettings` 增加"Agent 灵动岛"开关。
- 关闭中途：立即销毁窗口、停止推送；重新开启则重建窗口。

### 5.4 与现有浮层的共存分工

| 组件 | 职责 | 关系 |
|---|---|---|
| **灵动岛** | 跨应用环境感知：phase + 队列 + 待交互 + planning 摘要 | 全局 ambient，主窗口不可见时仍在 |
| `DesktopActionVisualOverlay`（in-app z-120） | 桌面操作富可视化（光标路径、坐标、stage） | 主窗口聚焦时显示；岛屿 compact 仅提示"需要你接手·桌面操作"。**互补，不合并** |
| `AgentHeader` pill | 单 thread in-flow 状态 | 保留；岛屿是全局聚合 |
| `PlanningReminderRail` | 到期提醒的 ack/snooze 操作 | 保留交互；岛屿 expanded 展示紧迫 planning 摘要并可跳转，不接管 ack/snooze |

---

## 6. 测试策略（`bun:test`）

### 6.1 纯逻辑单测（co-locate `*.test.ts`）

- `mapRuntimePhaseToIslandPhase` —— Lume phase → 岛屿 phase 全覆盖（含 compacting→running）。
- 主导会话选择与排序（needs-interaction > running > completed > error，同级按 recency）。
- `buildVisibilityKey` / dismiss 语义（key 不变隐藏、变化重现、跨日 rollover）。
- planning 紧迫度投影（todo/reminder 是否落入 1h 窗口、overdue）。
- 快照构建 + 节流/去重（80ms/2000ms/即时三类路径）。

### 6.2 Renderer 契约测（`renderToStaticMarkup`，避免 jsdom）

- `AgentIslandApp` compact：每 phase 渲染正确 label/图标/色（断言 `data-phase` + 文本）。
- expanded 卡片：会话行数 ≤3、planning 两列、空闲最近会话。
- 状态 → CSS class 映射。

### 6.3 service 订阅壳

把投影抽纯函数（§6.1 已测），service 只剩薄订阅壳，不强求测。

### 6.4 JSONL 协议测（可在 Windows 跑）

`NativeAgentIslandSnapshot` 序列化/反序列化 round-trip；intent 事件 schema 校验。NSPanel 绘制无法在 Windows 测，协议层可全测。

### 6.5 IPC 契约测

`AgentIslandState` shape 稳定性（防字段漂移）。

### 6.6 可测性边界（如实记录）

Swift NSPanel 渲染、macOS 26 原生路径、native host 真实 spawn——**仅 macOS 可验证**。Phase 1（Electron 面 + 全部纯逻辑/协议）在 Windows 可全测；Phase 2 原生绘制在 macOS 验证。

---

## 7. 实施分期（写计划时参考）

- **Phase 1（跨平台，Windows 可验证）**：`packages/shared` 类型契约 → `agent-island-projections.ts` 纯函数 + 单测 → `agent-island-service.ts` 订阅/推送 → `agent-island-window.ts` Electron 透明窗 → `apps/web` `?window=agent-island` 入口 + `AgentIslandApp` + CSS → preload IPC → 设置开关。端到端在 Windows 验证岛屿浮窗。
- **Phase 2（macOS）**：`packages/natives` Swift target → NSPanel/SwiftUI 视图 → `mac-agent-island-native-host.ts` → JSONL 协议联调 → macOS 26 SDK 核对刘海 API → CI macOS runner。复用 Phase 1 的 service 与状态机，零返工。

---

## 8. 待办与开放问题

- [ ] macOS 26 刘海锚定 API 精确签名（Phase 2 在 macOS 核对）。
- [ ] Swift target 的 CI 构建/签名/公证流程对齐 `packages/natives` 既有约定。
- [ ] `desktop_action` 作为 interactionKind 第四类，需确认 sidecar `DESKTOP_ACTION_REQUEST` 事件字段足够投影岛屿 detail。
- [ ] 空闲仪表盘可见性是否默认开启（避免 idle 时持续浮窗）——可在设置中暴露。
