# Agent 灵动岛（Agent Island）实现计划 — Phase 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lume 实现跨平台系统级悬浮"灵动岛"（Electron 透明置顶窗），让 agent 运行态、待交互、紧迫规划在主窗口不可见时仍可被感知。

**Architecture:** 方案 A——状态真源在 `apps/desktop` 主进程（`agent-island-service` 订阅 sidecar 事件流 + 投影快照 + 节流推送）。岛屿是独立 renderer 进程（`?view=agent-island`），与主窗口不共享 Jotai 状态。纯投影逻辑抽到 `packages/shared`（落 TDD 循环）。主窗口不动。

**Tech Stack:** Electron（BrowserWindow/ipcMain）、React 18 + TypeScript、`@base-ui`/shadcn/Tailwind v4、纯 CSS 过渡（无动画库）、`bun:test` + `renderToStaticMarkup` 契约测。

**参考 spec:** `docs/superpowers/specs/2026-08-04-agent-island-design.md`

---

## Global Constraints

- **命名约定**：子窗口分流用 `?view=agent-island`（非 `?window=`），与 `quick-input`/`browser-annotation` 一致。
- **Bridge**：全局名 `window.electronAPI`（单一入口 + 子命名空间）。新增 IPC 命令/事件必须同时加到**双副本 allowlist**：`apps/desktop/src/preload.ts` 与 `apps/desktop/src/electron-security.ts`。
- **主进程结构**：单文件 `apps/desktop/src/main.ts`；IPC 走 `lume:invoke` → `dispatchCommand` switch；新命令必须加 case（default 分支拒绝未列举命令）。
- **UI 原子**：交互控件用 `apps/web/src/components/ui` 下的 shadcn 原子（Button/Switch 等），不手写完整按钮样式；岛屿 morphing 表面容器可手写 CSS。
- **测试**：`bun:test`；renderer 契约测用 `renderToStaticMarkup`（react-dom/server），不打 jsdom；纯逻辑测 co-locate `*.test.ts`。`apps/web` 测试自动采集 `src/**/*.{test.ts,test.tsx}`；`packages/shared` 走 `@lume/shared test:unit`。
- **主题**：岛屿表面恒定深色 `#09090a`，phase 色取 token：`--lume-accent`(运行)/`--lume-warning`(待交互)/`--lume-success`(完成)/`--lume-danger`(错误)。
- **提交策略**：遵循用户偏好——按主题合并 5–7 commit、emoji 前缀；**仅在用户明确要求时提交**，本计划不自动 commit，每个任务以"测试通过"为完成判据。
- **平台**：Phase 1 面向 Windows/Linux/macOS<26 的 Electron 浮动窗。macOS 26 原生刘海（Swift）属 Phase 2，不在本计划。

---

## File Structure

**新建：**
- `packages/shared/src/types/agent-island.ts` — 类型契约 + `AGENT_ISLAND_IPC_CHANNELS`
- `packages/shared/src/agent-island-projections.ts` — 纯投影函数（可测）
- `packages/shared/src/agent-island-projections.test.ts` — 投影单测
- `apps/desktop/src/agent-island-service.ts` — 状态机 service（订阅/投影/节流/推送）
- `apps/desktop/src/agent-island-window.ts` — 岛屿 BrowserWindow 管理
- `apps/web/src/components/agent-island/AgentIslandApp.tsx` — 岛屿 renderer 壳（IPC 订阅）
- `apps/web/src/components/agent-island/AgentIslandSurface.tsx` — 纯展示（compact + expanded）
- `apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx` — 契约测
- `apps/web/src/components/agent-island/agent-island.css` — 布局 + CSS 过渡

**修改：**
- `packages/shared/src/types/index.ts` — `export * from "./agent-island"`
- `packages/shared/src/types/general-settings.ts` — `GeneralSettings` 加 `agentIsland`
- `apps/desktop/src/main.ts` — onNotification tap、dispatchCommand case、trusted windows、init/dispose、URL helper
- `apps/desktop/src/preload.ts` + `apps/desktop/src/electron-security.ts` — allowlist 双副本
- `apps/web/src/App.tsx` — `?view=agent-island` 分流
- `apps/web/src/components/settings/general-settings-state.ts` — `mergeGeneralSettings` 合并 agentIsland
- `apps/web/src/components/settings/GeneralSettings.tsx` — 开关 UI

> **职责边界**：`agent-island-projections.ts`（纯逻辑，可测）↔ `agent-island-service.ts`（订阅壳，依赖投影）↔ `agent-island-window.ts`（窗口生命周期）↔ `AgentIslandApp/Surface`（展示）。每文件单一职责，便于在 context 内推理。

---

## Task 1: Shared 类型契约与 IPC 通道

**Files:**
- Create: `packages/shared/src/types/agent-island.ts`
- Modify: `packages/shared/src/types/index.ts`（追加一行 export）
- Test: `packages/shared/src/types/agent-island.contract.test.ts`

**Interfaces:**
- Produces: `AgentIslandPhase`、`AgentIslandPresentation`、`AgentIslandInteractionKind`、`AgentIslandSessionSnapshot`、`AgentIslandPlanningSnapshot`、`AgentIslandState`、`AgentIslandWindowSnapshot`、`AGENT_ISLAND_IPC_CHANNELS`。后续所有任务 import 自 `@lume/shared`。

- [ ] **Step 1: 写契约测（类型 shape + JSON round-trip）**

`packages/shared/src/types/agent-island.contract.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { AGENT_ISLAND_IPC_CHANNELS } from './agent-island'
import type { AgentIslandState, AgentIslandWindowSnapshot } from './agent-island'

describe('agent-island 契约', () => {
  test('IPC 通道常量值正确', () => {
    // STATE 是事件通道（main→renderer，lume:event:<channel>），用冒号风格
    expect(AGENT_ISLAND_IPC_CHANNELS.STATE).toBe('agent:island:state')
    // INTENT 是 invoke 命令（renderer→main，经 lume:invoke→dispatchCommand），用下划线风格
    expect(AGENT_ISLAND_IPC_CHANNELS.INTENT).toBe('agent_island_intent')
  })

  test('AgentIslandWindowSnapshot 可 JSON round-trip', () => {
    const state: AgentIslandState = {
      presentation: 'compact',
      primarySessionId: 't1',
      compactLabel: 'Lume · 正在执行',
      sessions: [{
        threadId: 't1', title: '任务A', phase: 'running',
        detail: '第 1 步 · ls', activityLines: ['ls'], attention: false,
        unread: false, terminalAt: null, lastActivityAt: 1,
      }],
      planning: { todos: [], reminders: [] },
      updatedAt: 1,
    }
    const snap: AgentIslandWindowSnapshot = { state, expandedHeight: 32 }
    const round = JSON.parse(JSON.stringify(snap)) as AgentIslandWindowSnapshot
    expect(round.state.primarySessionId).toBe('t1')
    expect(round.state.sessions[0].phase).toBe('running')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/shared/src/types/agent-island.contract.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`packages/shared/src/types/agent-island.ts`:
```ts
/** Agent 灵动岛类型契约。设计参考 Cindy (makecindy/cindy) 的 Agent Island。 */

export type AgentIslandPhase =
  | 'idle'
  | 'running'
  | 'needs-interaction'
  | 'completed'
  | 'error'

export type AgentIslandPresentation = 'hidden' | 'compact' | 'expanded'

export type AgentIslandInteractionKind =
  | 'permission'
  | 'ask_user_question'
  | 'plan_review'
  | 'desktop_action' // Lume 特有扩展

export interface AgentIslandSessionSnapshot {
  threadId: string
  title: string
  phase: AgentIslandPhase
  interactionKind?: AgentIslandInteractionKind
  detail: string
  activityLines: string[]
  attention: boolean
  unread: boolean
  terminalAt: number | null
  lastActivityAt: number
}

export interface AgentIslandPlanningItem {
  id: string
  title: string
  kind: 'todo' | 'calendar_event'
  dueAt: number
  overdue: boolean
}

export interface AgentIslandPlanningSnapshot {
  todos: AgentIslandPlanningItem[]
  reminders: AgentIslandPlanningItem[]
}

export interface AgentIslandState {
  presentation: AgentIslandPresentation
  primarySessionId: string | null
  compactLabel: string
  sessions: AgentIslandSessionSnapshot[]
  planning: AgentIslandPlanningSnapshot
  updatedAt: number
}

/** 推给岛屿窗口的完整包（Electron 路径需要 expandedHeight）。 */
export interface AgentIslandWindowSnapshot {
  state: AgentIslandState
  expandedHeight: number
}

export type AgentIslandIntentName =
  | 'set-expanded'
  | 'set-hovered'
  | 'dismiss'
  | 'open-main'
  | 'open-session'

export interface AgentIslandIntent {
  name: AgentIslandIntentName
  value?: boolean
  threadId?: string
}

export const AGENT_ISLAND_IPC_CHANNELS = {
  /** main → 岛屿窗口：推送状态快照（事件通道） */
  STATE: 'agent:island:state',
  /** 岛屿窗口 → main：用户意图（invoke 命令，下划线风格，匹配 dispatchCommand case） */
  INTENT: 'agent_island_intent',
} as const
```

`packages/shared/src/types/index.ts` 末尾追加：
```ts
export * from "./agent-island";
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test packages/shared/src/types/agent-island.contract.test.ts`
Expected: PASS

- [ ] **Step 5: 验证 barrel 可见**

Run: `bun run --filter @lume/shared test:unit`
Expected: PASS（新类型经 `@lume/shared` 自动导出）

---

## Task 2: 设置类型（agentIsland.enabled）

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts:33-68`
- Modify: `apps/web/src/components/settings/general-settings-state.ts`（`mergeGeneralSettings`）

**Interfaces:**
- Produces: `GeneralSettings.agentIsland: { enabled: boolean }`、`UpdateGeneralSettingsInput.agentIsland?: { enabled?: boolean }`、`GENERAL_SETTINGS_DEFAULTS.agentIsland = { enabled: true }`。

- [ ] **Step 1: 写期望（在 general-settings-state 测试或新测中）**

若 `general-settings-state` 已有测试则追加；否则新建 `apps/web/src/components/settings/general-settings-state.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { mergeGeneralSettings } from './general-settings-state'
import { GENERAL_SETTINGS_DEFAULTS } from './general-settings-state'

describe('agentIsland 设置合并', () => {
  test('默认开启', () => {
    expect(GENERAL_SETTINGS_DEFAULTS.agentIsland.enabled).toBe(true)
  })
  test('部分更新 agentIsland', () => {
    const merged = mergeGeneralSettings(GENERAL_SETTINGS_DEFAULTS, { agentIsland: { enabled: false } })
    expect(merged.agentIsland.enabled).toBe(false)
  })
})
```
> 若 `mergeGeneralSettings` 签名是 `(current, updates)`，按实际调整。先读 `general-settings-state.ts:125-160` 确认。

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/web/src/components/settings/general-settings-state.test.ts`
Expected: FAIL（`agentIsland` 不存在）

- [ ] **Step 3: 写实现**

`packages/shared/src/types/general-settings.ts`：
```ts
// 在 GeneralSettingsWindowBehavior 之后新增
export interface GeneralSettingsAgentIsland {
  enabled: boolean
}
```
在 `GeneralSettings`（行 46-56）末尾加字段：
```ts
  agentIsland: GeneralSettingsAgentIsland
```
在 `UpdateGeneralSettingsInput`（行 58-68）末尾加：
```ts
  agentIsland?: Partial<GeneralSettingsAgentIsland>
```
在 `GENERAL_SETTINGS_DEFAULTS`（行 ~154，`windowBehavior` 同级）加：
```ts
  agentIsland: { enabled: true },
```

`apps/web/src/components/settings/general-settings-state.ts` 的 `mergeGeneralSettings`（行 125-160）加分支：
```ts
  agentIsland: {
    enabled: updates.agentIsland?.enabled ?? current.agentIsland?.enabled ?? true,
  },
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test apps/web/src/components/settings/general-settings-state.test.ts`
Expected: PASS

---

## Task 3: 纯投影函数（核心可测逻辑）

**Files:**
- Create: `packages/shared/src/agent-island-projections.ts`
- Test: `packages/shared/src/agent-island-projections.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimePhase`（来自 `./types/agent`）、Task 1 的岛屿类型。
- Produces: `mapRuntimePhaseToIslandPhase`、`selectPrimarySession`、`buildVisibilityKey`、`projectPlanning`、`buildSnapshot`、`IslandSessionInput`。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/agent-island-projections.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import {
  mapRuntimePhaseToIslandPhase,
  selectPrimarySession,
  buildVisibilityKey,
  projectPlanning,
} from './agent-island-projections'
import type { IslandSessionInput } from './agent-island-projections'

describe('mapRuntimePhaseToIslandPhase', () => {
  test('streaming/compacting → running', () => {
    expect(mapRuntimePhaseToIslandPhase('streaming')).toBe('running')
    expect(mapRuntimePhaseToIslandPhase('compacting')).toBe('running')
  })
  test('awaiting_* → needs-interaction', () => {
    expect(mapRuntimePhaseToIslandPhase('awaiting_permission')).toBe('needs-interaction')
    expect(mapRuntimePhaseToIslandPhase('awaiting_user_answer')).toBe('needs-interaction')
  })
  test('completed/errored/idle 直映', () => {
    expect(mapRuntimePhaseToIslandPhase('completed')).toBe('completed')
    expect(mapRuntimePhaseToIslandPhase('errored')).toBe('error')
    expect(mapRuntimePhaseToIslandPhase('idle')).toBe('idle')
  })
})

function session(over: Partial<IslandSessionInput>): IslandSessionInput {
  return {
    threadId: 't', title: '', phase: 'idle', detail: '', activityLines: [],
    attention: false, unread: false, terminalAt: null, lastActivityAt: 0, ...over,
  }
}

describe('selectPrimarySession', () => {
  test('needs-interaction 优先于 running', () => {
    const list = selectPrimarySession([
      session({ threadId: 'a', phase: 'running', lastActivityAt: 5 }),
      session({ threadId: 'b', phase: 'needs-interaction', lastActivityAt: 1 }),
    ])
    expect(list.primarySessionId).toBe('b')
    expect(list.sessions).toHaveLength(2)
  })
  test('同级按 lastActivityAt 降序', () => {
    const list = selectPrimarySession([
      session({ threadId: 'a', phase: 'running', lastActivityAt: 1 }),
      session({ threadId: 'b', phase: 'running', lastActivityAt: 9 }),
    ])
    expect(list.primarySessionId).toBe('b')
  })
  test('空列表返回 null primary', () => {
    expect(selectPrimarySession([]).primarySessionId).toBeNull()
  })
})

describe('buildVisibilityKey', () => {
  test('同状态同 key', () => {
    const s = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    expect(buildVisibilityKey(s, [])).toBe(buildVisibilityKey(s, []))
  })
  test('detail 变 → key 变', () => {
    const a = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    const b = session({ threadId: 't1', phase: 'running', detail: 'y', lastActivityAt: 3 })
    expect(buildVisibilityKey(a, [])).not.toBe(buildVisibilityKey(b, []))
  })
})

describe('projectPlanning', () => {
  test('只保留 1h 内或逾期的项', () => {
    const now = 1_000_000
    const snap = projectPlanning({
      todos: [
        { id: 'soon', title: '即将', kind: 'todo', dueAt: now + 30 * 60_000, overdue: false },
        { id: 'later', title: '远期', kind: 'todo', dueAt: now + 3 * 3_600_000, overdue: false },
      ],
      reminders: [
        { id: 'over', title: '逾期', kind: 'calendar_event', dueAt: now - 1000, overdue: true },
      ],
    }, now)
    expect(snap.todos.map((t) => t.id)).toEqual(['soon'])
    expect(snap.reminders.map((r) => r.id)).toEqual(['over'])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/shared/src/agent-island-projections.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`packages/shared/src/agent-island-projections.ts`:
```ts
import type { AgentRuntimePhase } from "./types/agent"
import type {
  AgentIslandPhase,
  AgentIslandPlanningItem,
  AgentIslandPlanningSnapshot,
  AgentIslandSessionSnapshot,
  AgentIslandState,
} from "./types/agent-island"

const PLANNING_ATTENTION_WINDOW_MS = 60 * 60_000 // 1h

/** service 组装的会话输入（投影前），由 service 从事件聚合。 */
export interface IslandSessionInput {
  threadId: string
  title: string
  phase: AgentIslandPhase
  interactionKind?: AgentIslandSessionSnapshot['interactionKind']
  detail: string
  activityLines: string[]
  attention: boolean
  unread: boolean
  terminalAt: number | null
  lastActivityAt: number
}

const PHASE_PRIORITY: Record<AgentIslandPhase, number> = {
  'needs-interaction': 0,
  running: 1,
  completed: 2,
  error: 3,
  idle: 4,
}

export function mapRuntimePhaseToIslandPhase(phase: AgentRuntimePhase): AgentIslandPhase {
  switch (phase) {
    case "streaming":
    case "compacting":
      return "running"
    case "awaiting_permission":
    case "awaiting_user_answer":
      return "needs-interaction"
    case "completed":
      return "completed"
    case "errored":
      return "error"
    case "idle":
    default:
      return "idle"
  }
}

const PHASE_LABEL: Record<AgentIslandPhase, string> = {
  idle: '空闲',
  running: '正在执行',
  'needs-interaction': '需要你接手',
  completed: '任务完成',
  error: '执行出错',
}

export function selectPrimarySession(inputs: IslandSessionInput[]): {
  primarySessionId: string | null
  sessions: IslandSessionInput[]
} {
  const sorted = [...inputs].sort((a, b) => {
    const dp = PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase]
    if (dp !== 0) return dp
    return b.lastActivityAt - a.lastActivityAt
  })
  return { primarySessionId: sorted[0]?.threadId ?? null, sessions: sorted.slice(0, 3) }
}

export function buildVisibilityKey(
  primary: IslandSessionInput | null,
  planningKeys: string[],
): string {
  if (!primary) return planningKeys.join('|')
  return [
    primary.threadId,
    primary.phase,
    primary.lastActivityAt,
    primary.detail,
    planningKeys.join(','),
  ].join(':')
}

export function projectPlanning(
  input: { todos: AgentIslandPlanningItem[]; reminders: AgentIslandPlanningItem[] },
  now: number,
): AgentIslandPlanningSnapshot {
  const within = (it: AgentIslandPlanningItem) =>
    it.overdue || it.dueAt - now <= PLANNING_ATTENTION_WINDOW_MS
  return {
    todos: input.todos.filter(within),
    reminders: input.reminders.filter(within),
  }
}

export function buildSnapshot(
  inputs: IslandSessionInput[],
  planning: AgentIslandPlanningSnapshot,
  now: number,
): AgentIslandState {
  const { primarySessionId, sessions } = selectPrimarySession(inputs)
  const primary = sessions.find((s) => s.threadId === primarySessionId) ?? null
  const label = primary ? PHASE_LABEL[primary.phase] : '工作提醒'
  return {
    presentation: inputs.length > 0 || planning.todos.length > 0 || planning.reminders.length > 0
      ? 'compact'
      : 'hidden',
    primarySessionId,
    compactLabel: `Lume · ${label}`,
    sessions: sessions.map<AgentIslandSessionSnapshot>((s) => ({ ...s })),
    planning,
    updatedAt: now,
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test packages/shared/src/agent-island-projections.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 shared 测试回归**

Run: `bun run --filter @lume/shared test:unit`
Expected: PASS

---

## Task 4: Desktop IPC 管线（allowlist + dispatchCommand）

**Files:**
- Modify: `apps/desktop/src/preload.ts:3-88`（两份 allowlist）
- Modify: `apps/desktop/src/electron-security.ts:12-97`（两份 allowlist 副本）
- Modify: `apps/desktop/src/main.ts`（`dispatchCommand` switch + `getTrustedWindows`）

**Interfaces:**
- Consumes: Task 1 的 `AGENT_ISLAND_IPC_CHANNELS`、`AgentIslandIntent`。
- Produces: `agent_island_intent` invoke 命令合法；`agent:island:state` 事件通道合法；`getTrustedWindows()` 含岛屿窗口。

- [ ] **Step 1: 加 allowlist（双副本）**

`apps/desktop/src/preload.ts` 的 `ALLOWED_RENDERER_INVOKE_COMMANDS`（行 3-78）与 `apps/desktop/src/electron-security.ts` 的同名 Set（行 12-87）**两处都加**：
```ts
  'agent_island_intent',
```
两处 `ALLOWED_RENDERER_EVENT_CHANNELS`（preload 行 80-88 + electron-security 行 89-97）**两处都加**：
```ts
  'agent:island:state',
```

- [ ] **Step 2: `getTrustedWindows` 含岛屿窗口**

`apps/desktop/src/main.ts:339-341` 的 `getTrustedWindows()`，把岛屿窗口加入返回数组。岛屿窗口变量在 Task 5 引入；此处先加引用（Task 5 创建变量后生效）：
```ts
function getTrustedWindows() {
  return [mainWindow, quickInputWindow, islandWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  )
}
```
> 若 `islandWindow` 变量尚未声明，Task 5 Step 1 会补 `let islandWindow: BrowserWindow | null = null`。

- [ ] **Step 3: dispatchCommand 加 case（占位指向 Task 6 的 service）**

`apps/desktop/src/main.ts` 的 `dispatchCommand`（行 1345-2161）switch 内，`case 'sidecar_call'`（行 1495）附近加：
```ts
case 'agent_island_intent': {
  await agentIslandService?.handleIntent(payload as AgentIslandIntent)
  return null
}
```
顶部 import：
```ts
import type { AgentIslandIntent } from '@lume/shared'
```
`agentIslandService` 变量与 `handleIntent` 在 Task 6 引入；本步先写 case，TS 会因变量未定义报错——属预期，Task 6 完成后消除。

- [ ] **Step 4: 类型检查**

Run: `bun run --filter @lume/desktop build` 或 `cd apps/desktop && bunx tsc --noEmit`
Expected: 仅 `agentIslandService`/`islandWindow` 未定义的错误（后续任务消除），无 allowlist 相关错误。

---

## Task 5: 岛屿 BrowserWindow（`agent-island-window.ts`）

**Files:**
- Create: `apps/desktop/src/agent-island-window.ts`
- Modify: `apps/desktop/src/main.ts`（模块级 `islandWindow` 变量 + URL helper）

**Interfaces:**
- Consumes: `getDevServerUrl`/`getPackagedAppUrl` 模式（参考 `apps/desktop/src/desktop-core.ts:702` 的 `getQuickInputUrl`）。
- Produces: `createIslandWindow()`、`getIslandWindow()`、`destroyIslandWindow()`、`getAgentIslandUrl()`、模块级 `islandWindow`。

- [ ] **Step 1: 模块级变量与 URL helper**

`apps/desktop/src/main.ts` 顶部（`quickInputWindow` 声明附近，行 ~224）加：
```ts
let islandWindow: BrowserWindow | null = null
```

`apps/desktop/src/desktop-core.ts`（`getQuickInputUrl` 行 702-712 旁）加：
```ts
/** 构建岛屿窗口加载 URL：dev 走 dev server，packaged 走 app 协议入口，均带 ?view=agent-island。 */
export function getAgentIslandUrl(opts: {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
}): string {
  if (opts.appIsPackaged) {
    return `${opts.appProtocolOrigin}/index.html?view=agent-island`
  }
  return `${opts.devServerUrl}/?view=agent-island`
}
```

- [ ] **Step 2: 写窗口模块**

`apps/desktop/src/agent-island-window.ts`:
```ts
import { BrowserWindow, screen } from 'electron'
import { resolve } from 'node:path'
import { createSecureWebPreferences } from './electron-security'
import { getAgentIslandUrl } from './desktop-core'

const ISLAND_DEFAULT_WIDTH = 420
const ISLAND_DEFAULT_HEIGHT = 32
const ISLAND_MIN_WIDTH = 320
const ISLAND_MAX_WIDTH = 620
const ISLAND_MAX_HEIGHT = 640

export interface IslandWindowDeps {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
  desktopRoot: string
}

function resolveWindowPosition(workArea: Electron.Rectangle) {
  const width = Math.min(Math.max(ISLAND_DEFAULT_WIDTH, ISLAND_MIN_WIDTH), ISLAND_MAX_WIDTH)
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  // Windows/Linux 避让任务栏；macOS 贴顶（bounds.y）
  const y = process.platform === 'darwin' ? workArea.y : workArea.y + 12
  return { x, y, width, height: ISLAND_DEFAULT_HEIGHT }
}

export function createIslandWindow(deps: IslandWindowDeps): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = resolveWindowPosition(display.workArea)
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: createSecureWebPreferences({
      preload: resolve(deps.desktopRoot, 'dist', 'preload', 'preload.cjs'),
    }),
  })
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver')
  if (process.platform !== 'win32') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void win.loadURL(getAgentIslandUrl({
    appIsPackaged: deps.appIsPackaged,
    appProtocolOrigin: deps.appProtocolOrigin,
    devServerUrl: deps.devServerUrl,
  }))
  return win
}

export function clampIslandHeight(win: BrowserWindow, expandedHeight: number) {
  if (win.isDestroyed()) return
  const h = Math.min(Math.max(expandedHeight, ISLAND_DEFAULT_HEIGHT), ISLAND_MAX_HEIGHT)
  const [width] = win.getSize()
  const [x, y] = win.getPosition()
  win.setBounds({ x, y, width, height: h }, false)
}

export { ISLAND_DEFAULT_WIDTH, ISLAND_DEFAULT_HEIGHT }
```

- [ ] **Step 3: main.ts 持有与销毁**

`apps/desktop/src/main.ts` 导入并加 getter（参考 `quickInputWindow` 模式）：
```ts
import { createIslandWindow, destroyIslandWindow } from './agent-island-window'

export function getIslandWindow() { return islandWindow }
export async function ensureIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) return islandWindow
  islandWindow = createIslandWindow({
    appIsPackaged: app.isPackaged,
    appProtocolOrigin: /* 复用现有 appProtocolOrigin 变量 */,
    devServerUrl: getDevServerUrl(),
    desktopRoot: DESKTOP_ROOT,
  })
  islandWindow.on('closed', () => { if (islandWindow === arguments[0]) islandWindow = null })
  islandWindow.once('ready-to-show', () => islandWindow?.showInactive())
  return islandWindow
}
export function destroyIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) islandWindow.destroy()
  islandWindow = null
}
```
> `appProtocolOrigin` / `getDevServerUrl` / `DESKTOP_ROOT` 按文件内既有变量复用（见 `createQuickInputWindow` 行 1225-1274 的用法）。`closed` 回调用闭包捕获 win 更稳：
> ```ts
> const win = islandWindow; win.on('closed', () => { if (islandWindow === win) islandWindow = null })
> ```

- [ ] **Step 4: 类型检查**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: 仅 `agentIslandService` 未定义错误（Task 6 消除）。

---

## Task 6: 岛屿 service（订阅/投影/节流/推送）

**Files:**
- Create: `apps/desktop/src/agent-island-service.ts`
- Modify: `apps/desktop/src/main.ts`（`agentIslandService` 变量 + getter）

**Interfaces:**
- Consumes: Task 3 投影函数、Task 5 `getIslandWindow`/`clampIslandHeight`、`AGENT_ISLAND_IPC_CHANNELS.STATE`、sidecar 通知 method（`agent:runtime-status-changed` 等，见 `AGENT_IPC_CHANNELS`）、`sidecarHost.call`（调 `planning-todo:list` / `planning-todo:list-active-reminders`）。
- Produces: `AgentIslandService` 类（`start`/`handleIntent`/`destroy`）、模块级 `agentIslandService` + getter。

> **测试策略**：投影逻辑已在 Task 3 全测。本 service 是订阅壳（依赖 Electron `webContents.send` 与 sidecar），按 spec §6.3 不强求单测，以端到端（Task 11）验证。

- [ ] **Step 1: 写 service**

`apps/desktop/src/agent-island-service.ts`:
```ts
import type { BrowserWindow } from 'electron'
import {
  AGENT_ISLAND_IPC_CHANNELS,
  type AgentIslandIntent,
  type AgentIslandState,
  type IslandSessionInput,
} from '@lume/shared'
import {
  buildSnapshot,
  buildVisibilityKey,
  mapRuntimePhaseToIslandPhase,
  projectPlanning,
} from '@lume/shared'
// 注意：@lume/shared 顶层 barrel 需 re-export 投影函数（见 Step 4）

const PUSH_THROTTLE_MS = 80
const AGENT_STREAM_PUSH_THROTTLE_MS = 2000
const PLANNING_REFRESH_MS = 5 * 60_000
const UNREAD_RETAIN_MS = 10 * 60_000

export interface AgentIslandServiceDeps {
  isEnabled: () => boolean
  getIslandWindow: () => BrowserWindow | null
  ensureIslandWindow: () => Promise<BrowserWindow>
  /** 调 sidecar RPC（main 已有 sidecarHost.call） */
  callSidecar: <T = unknown>(method: string, params?: unknown) => Promise<T>
  /** 通知主窗口跳转（open-main / open-session） */
  openMain: () => void
  openSession: (threadId: string) => void
}

interface RuntimeStatusLike {
  threadId: string
  phase: string
  queuedCount?: number
  toolName?: string
  updatedAt: number
}

export class AgentIslandService {
  private sessions = new Map<string, IslandSessionInput>()
  private titles = new Map<string, string>()
  private planning = { todos: [], reminders: [] }
  private manuallyExpanded = false
  private hoverExpanded = false
  private dismissedKey: string | null = null
  private lastPushAt = 0
  private lastStateJson = ''
  private planningTimer: NodeJS.Timeout | null = null

  constructor(private deps: AgentIslandServiceDeps) {}

  async start() {
    await this.refreshPlanning()
    this.planningTimer = setInterval(() => void this.refreshPlanning(), PLANNING_REFRESH_MS)
    this.push(true)
  }

  /** 由 main.ts onNotification 调用：tap sidecar 事件流。 */
  handleSidecarNotification(method: string, params: unknown) {
    if (method === 'agent:runtime-status-changed') {
      const status = (params as { status: RuntimeStatusLike })?.status
      if (status) this.applyStatus(status)
    }
    // 其余：tool/task 事件追加 activityLines、permission/ask_user/desktop_action 设 needs-interaction
    // 按 AGENT_IPC_CHANNELS 的 method 分支补充（实现时对照 sidecar 事件名）
    this.push(false)
  }

  private applyStatus(status: RuntimeStatusLike) {
    const phase = mapRuntimePhaseToIslandPhase(status.phase as never)
    const existing = this.sessions.get(status.threadId)
    this.sessions.set(status.threadId, {
      threadId: status.threadId,
      title: this.titles.get(status.threadId) ?? status.threadId,
      phase,
      detail: status.toolName ?? '',
      activityLines: existing?.activityLines ?? [],
      attention: phase === 'needs-interaction',
      unread: phase === 'completed' || phase === 'error',
      terminalAt: phase === 'completed' || phase === 'error' ? Date.now() : null,
      lastActivityAt: status.updatedAt ?? Date.now(),
    })
  }

  private async refreshPlanning() {
    try {
      const [todos, reminders] = await Promise.all([
        this.deps.callSidecar('planning-todo:list', { view: 'open' }),
        this.deps.callSidecar('planning-todo:list-active-reminders', {}),
      ])
      this.planning = { todos: extractItems(todos), reminders: extractItems(reminders) }
    } catch {
      // 静默失败：planning 不可用时岛屿仅反映 agent 运行态
    }
    this.push(false)
  }

  async handleIntent(intent: AgentIslandIntent) {
    switch (intent.name) {
      case 'set-expanded':
        this.manuallyExpanded = intent.value === true
        break
      case 'set-hovered':
        this.hoverExpanded = intent.value === true
        break
      case 'dismiss':
        this.dismissedKey = buildVisibilityKey(this.primaryInput(), this.planningKeys())
        this.manuallyExpanded = false
        break
      case 'open-main':
        this.deps.openMain()
        break
      case 'open-session':
        if (intent.threadId) this.deps.openSession(intent.threadId)
        break
    }
    this.push(true)
  }

  private primaryInput() {
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ?? null
  }
  private planningKeys() {
    return [...this.planning.todos, ...this.planning.reminders].map((p) => p.id)
  }

  private prune(now: number) {
    for (const [id, s] of this.sessions) {
      if (s.terminalAt && now - s.terminalAt > UNREAD_RETAIN_MS) this.sessions.delete(id)
    }
  }

  private push(force: boolean) {
    if (!this.deps.isEnabled()) return
    const now = Date.now()
    this.prune(now)
    const state: AgentIslandState = buildSnapshot(
      [...this.sessions.values()],
      projectPlanning(this.planning, now),
      now,
    )
    const expanded = this.manuallyExpanded || this.hoverExpanded
    state.presentation = state.presentation === 'hidden' ? 'hidden' : expanded ? 'expanded' : 'compact'
    // dismiss：key 不变则隐藏
    if (this.dismissedKey && buildVisibilityKey(this.primaryInput(), this.planningKeys()) === this.dismissedKey) {
      state.presentation = 'hidden'
    } else {
      this.dismissedKey = null
    }
    const json = JSON.stringify(state)
    if (!force && json === this.lastStateJson) return
    const throttle = state.presentation !== 'hidden' && this.urgent(state) ? PUSH_THROTTLE_MS : AGENT_STREAM_PUSH_THROTTLE_MS
    if (!force && now - this.lastPushAt < throttle) return
    this.lastPushAt = now
    this.lastStateJson = json
    void this.deps.ensureIslandWindow().then((win) => {
      if (win.isDestroyed()) return
      win.webContents.send(`lume:event:${AGENT_ISLAND_IPC_CHANNELS.STATE}`, { state })
    })
  }

  private urgent(state: AgentIslandState) {
    return state.sessions.some((s) => s.phase === 'needs-interaction' || s.phase === 'completed' || s.phase === 'error')
  }

  destroy() {
    if (this.planningTimer) clearInterval(this.planningTimer)
    this.planningTimer = null
  }
}

function extractItems(res: unknown): import('@lume/shared').AgentIslandPlanningItem[] {
  // 把 planning-todo:list / list-active-reminders 的响应映射为 AgentIslandPlanningItem
  // 字段映射在实现时按 PlanningTodo / ActivePlanningReminder 的实际形状补充
  return []
}
```
> `extractItems` 的字段映射需对照 `PlanningTodo`/`ActivePlanningReminder`（`@lume/shared`）实际字段完成；本骨架给出结构。

- [ ] **Step 2: shared barrel 导出投影函数**

`packages/shared/src/index.ts` 加：
```ts
export * from "./agent-island-projections";
```
> 注意：`IslandSessionInput` 也由此导出，供 service import。

- [ ] **Step 3: main.ts 装配 service**

`apps/desktop/src/main.ts`：
```ts
import { AgentIslandService } from './agent-island-service'

let agentIslandService: AgentIslandService | null = null
function getAgentIslandService() {
  if (!agentIslandService) {
    agentIslandService = new AgentIslandService({
      isEnabled: () => {
        const s = getSettingsBroker().read()
        return (s.generalSettings as { agentIsland?: { enabled?: boolean } })?.agentIsland?.enabled !== false
      },
      getIslandWindow: () => islandWindow,
      ensureIslandWindow,
      callSidecar: (method, params) => sidecarHost.call(method, params ?? null),
      openMain: () => { mainWindow?.show(); mainWindow?.focus() },
      openSession: (threadId) => emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method: 'agent:open-session', params: { threadId } }),
    })
  }
  return agentIslandService
}
```

- [ ] **Step 4: 类型检查**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: PASS（Task 4 的 `agentIslandService`/`islandWindow` 未定义错误已消除）

---

## Task 7: main.ts 接线（onNotification tap + 生命周期）

**Files:**
- Modify: `apps/desktop/src/main.ts:402-439`（`onNotification`）、`2868-2925`（`whenReady`）、`2936-2959`（`will-quit`）

**Interfaces:**
- Consumes: Task 6 `getAgentIslandService().start()/handleSidecarNotification()/destroy()`。

- [ ] **Step 1: onNotification 内 tap 一份给 service**

`apps/desktop/src/main.ts:402-439` 的 `createSidecarHost({ onNotification(method, params) { ... } })`，在 `emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method, params })` 之前加：
```ts
    getAgentIslandService().handleSidecarNotification(method, params)
```

- [ ] **Step 2: whenReady 启动 service**

`apps/desktop/src/main.ts` 的 `app.whenReady().then(...)`（行 2868-2925），在 `await createMainWindow()` 之后加：
```ts
  await getAgentIslandService().start()
```

- [ ] **Step 3: will-quit 拆卸**

`will-quit`（行 2946-2959）加：
```ts
  agentIslandService?.destroy()
  agentIslandService = null
  destroyIslandWindow()
```

- [ ] **Step 4: 类型检查 + 启动冒烟**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: PASS

---

## Task 8: 岛屿 renderer 入口与 Shell

**Files:**
- Modify: `apps/web/src/App.tsx:40-52`（`?view=agent-island` 分流）
- Create: `apps/web/src/components/agent-island/AgentIslandApp.tsx`

**Interfaces:**
- Consumes: `AGENT_ISLAND_IPC_CHANNELS.STATE`、`AgentIslandIntent`、`AgentIslandState`、`listen`/`invoke`（`@/lib/desktop-runtime`）。
- Produces: `AgentIslandApp`（订阅状态，渲染 `AgentIslandSurface`）。

- [ ] **Step 1: App.tsx 分流**

`apps/web/src/App.tsx:40-52`，在 `isBrowserAnnotationPopup` 分支后加：
```tsx
  const isAgentIsland =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('view') === 'agent-island'
  if (isAgentIsland) return <AgentIslandApp />
```
顶部 import：
```tsx
import { AgentIslandApp } from '@/components/agent-island/AgentIslandApp'
```

- [ ] **Step 2: 写 Shell（参考 QuickInputShell）**

`apps/web/src/components/agent-island/AgentIslandApp.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { listen } from '@/lib/desktop-runtime'
import { invoke } from '@/lib/desktop-runtime'
import { AGENT_ISLAND_IPC_CHANNELS, type AgentIslandIntent, type AgentIslandState } from '@lume/shared'
import { AgentIslandSurface } from './AgentIslandSurface'

export function AgentIslandApp() {
  const [state, setState] = useState<AgentIslandState | null>(null)

  useEffect(() => {
    document.getElementById('boot-root')?.remove()
    let active = true
    void listen<{ state: AgentIslandState }>(AGENT_ISLAND_IPC_CHANNELS.STATE, (payload) => {
      if (active) setState(payload.state)
    }).then((off) => { if (!active) off?.() })
    return () => { active = false }
  }, [])

  const sendIntent = (intent: AgentIslandIntent) => {
    void invoke(AGENT_ISLAND_IPC_CHANNELS.INTENT, intent)
  }

  return (
    <Provider>
      <TooltipProvider>
        {state && state.presentation !== 'hidden' && (
          <AgentIslandSurface state={state} onIntent={sendIntent} />
        )}
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
```
> `AGENT_ISLAND_IPC_CHANNELS.INTENT`（值 `'agent_island_intent'`）与 Task 4 的 `dispatchCommand` case、Task 4 双副本 allowlist 三处必须同字面量。

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: `AgentIslandSurface` 未定义（Task 9 创建）。

---

## Task 9: 岛屿视觉 Surface + CSS + 契约测

**Files:**
- Create: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Create: `apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`
- Create: `apps/web/src/components/agent-island/agent-island.css`

**Interfaces:**
- Consumes: `AgentIslandState`、`AgentIslandIntent`（props）。
- Produces: 纯展示组件（compact pill + expanded card），无 IPC、无 jotai。

- [ ] **Step 1: 写契约测**

`apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`:
```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentIslandState } from '@lume/shared'
import { AgentIslandSurface } from './AgentIslandSurface'

function state(over: Partial<AgentIslandState>): AgentIslandState {
  return {
    presentation: 'compact',
    primarySessionId: 't1',
    compactLabel: 'Lume · 正在执行',
    sessions: [{
      threadId: 't1', title: '任务A', phase: 'running', detail: '第 1 步 · ls',
      activityLines: ['ls'], attention: false, unread: false, terminalAt: null, lastActivityAt: 1,
    }],
    planning: { todos: [], reminders: [] },
    updatedAt: 1,
    ...over,
  }
}
const noop = () => undefined

describe('AgentIslandSurface 契约', () => {
  test('compact 渲染 compactLabel + 展开箭头', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({})} onIntent={noop} />,
    )
    expect(html).toContain('Lume · 正在执行')
    expect(html).toMatch(/data-phase="running"/)
  })
  test('expanded 渲染会话标题', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({ presentation: 'expanded' })} onIntent={noop} />,
    )
    expect(html).toContain('任务A')
  })
  test('needs-interaction 渲染"需要你接手"', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({ compactLabel: 'Lume · 需要你接手',
        sessions: [{ threadId: 't1', title: '任务A', phase: 'needs-interaction', detail: '',
          activityLines: [], attention: true, unread: false, terminalAt: null, lastActivityAt: 1 }] })} onIntent={noop} />,
    )
    expect(html).toContain('需要你接手')
    expect(html).toMatch(/data-phase="needs-interaction"/)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 写 Surface**

`apps/web/src/components/agent-island/AgentIslandSurface.tsx`:
```tsx
import { ChevronDown } from 'lucide-react'
import type { AgentIslandIntent, AgentIslandState } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import './agent-island.css'

const PHASE_DOT: Record<string, string> = {
  idle: 'bg-[var(--lume-text-muted)]',
  running: 'bg-[var(--lume-accent)] animate-pulse',
  'needs-interaction': 'bg-[var(--lume-warning)]',
  completed: 'bg-[var(--lume-success)]',
  error: 'bg-[var(--lume-danger)]',
}

export function AgentIslandSurface({
  state,
  onIntent,
}: {
  state: AgentIslandState
  onIntent: (intent: AgentIslandIntent) => void
}) {
  const expanded = state.presentation === 'expanded'
  const primary = state.sessions[0]
  return (
    <div className="island-root">
      <div
        className={cn('island-surface island-transition-surface', process.platform === 'darwin' ? 'island-mac' : 'island-floating')}
        data-phase={primary?.phase ?? 'idle'}
        onMouseEnter={() => onIntent({ name: 'set-hovered', value: true })}
        onMouseLeave={() => onIntent({ name: 'set-hovered', value: false })}
      >
        <button
          className="island-compact-layer"
          data-collapsed={expanded ? 'false' : 'true'}
          onClick={() => onIntent({ name: 'set-expanded', value: !expanded })}
        >
          <span className={cn('island-dot', PHASE_DOT[primary?.phase ?? 'idle'])} />
          <span className="island-label">{state.compactLabel}</span>
          <ChevronDown className={cn('island-chevron', expanded && 'rotate-180')} />
        </button>
        {expanded && primary && (
          <div className="island-expanded">
            <div className="island-expanded-head">
              <span className="island-title">{state.compactLabel.replace('Lume · ', '')}</span>
              <div className="island-actions">
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}>打开会话</Button>
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'set-expanded', value: false })}>收起</Button>
              </div>
            </div>
            <ul className="island-sessions">
              {state.sessions.map((s) => (
                <li key={s.threadId} className="island-session-row" onClick={() => onIntent({ name: 'open-session', threadId: s.threadId })}>
                  <span className={cn('island-dot', PHASE_DOT[s.phase])} />
                  <span className="island-session-title">{s.title}</span>
                  {s.detail && <span className="island-session-detail">{s.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
```
> `process.platform` 在 renderer 不可用——用 CSS 媒体/由 App 传 prop `platform`。修正：`AgentIslandApp` 传 `platform={navigator.userAgentData?.platform ?? navigator.platform}`，或用 body class（desktop main 进程 loadURL 时无法注入）。最简：在 `agent-island.css` 用 `:root` class，由 preload 注入 `document.documentElement.classList.add(process.platform)`（preload 有 Node）。本任务在 preload.ts 的 island 分支注入 platform class（见 Step 5）。

- [ ] **Step 4: 写 CSS**

`apps/web/src/components/agent-island/agent-island.css`:
```css
.island-root {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  width: 100vw;
  height: 100vh;
  background: transparent;
}
.island-surface {
  position: relative;
  width: 420px;
  height: 32px;
  background: #09090a;
  color: #fff;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.32);
  overflow: hidden;
}
.island-mac { border-radius: 0 0 18px 18px; border: 1px solid rgb(255 255 255 / 0.08); border-top: 0; }
.island-floating { border-radius: 0; border: 1px solid rgb(255 255 255 / 0.08); }
.island-transition-surface { transition: height 180ms cubic-bezier(0.2, 0, 0, 1); }
.island-expanded { transition: opacity 90ms ease-out; transition-delay: 45ms; }
.island-compact-layer {
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 32px; padding: 0 12px;
  background: transparent; border: 0; color: inherit; cursor: pointer;
}
.island-compact-layer:active { transform: scale(0.985); }
.island-dot { width: 6px; height: 6px; border-radius: 9999px; flex-shrink: 0; }
.island-label { font-size: 12px; font-weight: 500; flex: 1; text-align: left; }
.island-chevron { width: 14px; height: 14px; transition: transform 180ms ease; }
.island-expanded { padding: 4px 12px 12px; }
.island-expanded-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.island-title { font-size: 13px; font-weight: 600; }
.island-sessions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.island-session-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.island-session-row:hover { background: rgb(255 255 255 / 0.06); }
.island-session-title { font-size: 12px; }
.island-session-detail { font-size: 11px; opacity: 0.6; margin-left: auto; }
@media (prefers-reduced-motion: reduce) {
  .island-transition-surface, .island-expanded, .island-chevron { transition: none; }
}
```

- [ ] **Step 5: preload 注入 platform class**

`apps/desktop/src/preload.ts`，在 `contextBridge.exposeInMainWorld` 之前加：
```ts
if (typeof document !== 'undefined') {
  document.documentElement.classList.add(process.platform)
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`
Expected: PASS

- [ ] **Step 7: web 全量测试回归**

Run: `bun run --filter @lume/web test`
Expected: PASS

---

## Task 10: 设置开关 UI

**Files:**
- Modify: `apps/web/src/components/settings/GeneralSettings.tsx:171-216`（窗口行为卡片）
- Modify: `apps/web/src/components/settings/general-settings-state.ts`（已在 Task 2 处理 merge）

**Interfaces:**
- Consumes: Task 2 的 `settings.agentIsland.enabled`、`persistSettings`、`SettingsRow`、`LumeSwitch`（均在 GeneralSettings.tsx 内）。

- [ ] **Step 1: 加开关行**

`apps/web/src/components/settings/GeneralSettings.tsx` 的"窗口行为"`<SettingsCard>`（行 171）内，`closeToTray` 行之后加：
```tsx
          <SettingsRow
            label="Agent 灵动岛"
            desc="在所有应用之上显示 agent 运行状态悬浮岛（关闭后立即生效）"
          >
            <LumeSwitch
              checked={settings.agentIsland.enabled}
              disabled={saving}
              onCheckedChange={(checked) => void persistSettings({
                agentIsland: { enabled: checked },
              }, '灵动岛设置已保存')}
            />
          </SettingsRow>
```
> 若 `persistSettings` 的 `updates` 类型校验严格（`UpdateGeneralSettingsInput`），Task 2 已加 `agentIsland?` 字段，类型通过。

- [ ] **Step 2: 类型检查 + 视觉冒烟**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: PASS

---

## Task 11: 端到端验证（Windows）

**Files:** 无（手动验证）

- [ ] **Step 1: 启动 dev**

Run: 根目录 `bun run dev`（或 apps/desktop + apps/web 各自 dev 脚本）
Expected: 主窗口 + 岛屿窗口均加载（岛屿 `?view=agent-island`，初始 `presentation=hidden` 不显示内容但窗口已创建）。

- [ ] **Step 2: 触发 agent 运行**

在主窗口发起一个 agent 任务（如让 agent 执行一个工具）。
Expected: 顶部居中出现 compact 胶囊 `Lume · 正在执行` + accent 色点 + tool 步骤；阶段切换（streaming→completed）色点变 success。

- [ ] **Step 3: 验证交互**

- 点击 compact → 展开卡片显示会话行 + 打开/收起按钮。
- 悬停 → 防抖展开（~130ms）；移开 → 收起（~420ms）。
- 触发工具授权 → 胶囊变 `需要你接手` + warning 色。
- 关闭主窗口 → 岛屿仍可见（环境感知）。

- [ ] **Step 4: 验证设置开关**

设置 → 通用 → 关闭"Agent 灵动岛" → 岛屿消失；重新开启 → 恢复。

- [ ] **Step 5: 验证测试全绿**

Run: `bun run test:core`
Expected: PASS（shared + web 测试）

---

## Phase 2 纲要（macOS 原生刘海，可分离后续）

> Phase 2 复用 Phase 1 的 `AgentIslandService` 与状态机，零返工。仅新增"原生渲染面"。需独立 plan（任务需 macOS 26 SDK 验证上下文）。

- **P2-1**：`packages/natives` 新增 Swift target `macos-agent-island-helper`（`NSPanel` borderless/transparent/level:.statusBar + `NSHostingController` 承载 SwiftUI 视图镜像岛屿）。
- **P2-2**：JSONL-over-stdio 协议（`packages/shared` 已有 `NativeAgentIslandEvent`/snapshot 类型雏形）：inbound `{type:'snapshot', state}`、outbound `{type:'ready'|'intent'|'fatal'}`。
- **P2-3**：`apps/desktop/src/mac-agent-island-native-host.ts`：spawn + stdin 写快照 + stdout 逐行读 + 4s ready 超时 + exit/fatal 回退 Electron 窗。
- **P2-4**：`apps/desktop/src/macos-version.ts`：`isMacOS26OrLater()` 门槛。
- **P2-5**：`main.ts` 路由：macOS 26+ 优先 native host，失败回退 Electron 窗（Task 5）；macOS<26/Windows/Linux 直接 Electron 窗。
- **P2-6**：CI macOS runner 构建 universal binary + 签名/公证，对齐 `packages/natives` 既有约定。
- **P2-7**：刘海锚定 API 以 macOS 26 SDK 文档为准（`NSScreen.safeAreaInsets` / 新 notch 几何 API）——实现时核对，不臆造。

**开放问题（Phase 2 解决）**：
- macOS 26 精确刘海 API。
- Swift target CI 构建/签名流程。
- `desktop_action` intent 字段是否足够投影岛屿 detail（Phase 1 先按 permission/ask_user 覆盖）。

---

## Self-Review

**Spec coverage**：§1 架构（Task 1,4,5,6,7,8）✓；§2 状态机/数据流（Task 3,6）✓；§3 UI（Task 8,9）✓；§5 错误/设置/共存（Task 2,6,10 + Task 11 验证）✓；§6 测试（Task 1,2,3,9 契约+单测）✓。Phase 2（§4 Swift）独立纲要 ✓。
**Placeholder scan**：`extractItems` 字段映射标记为实现时按 `PlanningTodo`/`ActivePlanningReminder` 实际形状补全——这是依赖外部类型的确定性映射，非模糊占位；已明确指向类型来源。
**Type consistency**：`AGENT_ISLAND_IPC_CHANNELS.STATE='agent:island:state'`（事件）、`INTENT` 在 invoke 侧统一为命令字面量 `'agent_island_intent'`（Task 4/8 已注明对齐）；`AgentIslandIntent`/`AgentIslandState` 跨任务签名一致；`IslandSessionInput` 经 shared barrel 导出供 service 消费。
