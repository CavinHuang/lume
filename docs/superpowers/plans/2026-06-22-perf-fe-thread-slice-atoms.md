# 全局 Record atom 按 threadId 切片订阅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 5 个全局 `Record<string, T>` atom 改造成按 `threadId` 切片订阅，消除「线程 A 输出 → 线程 B 组件重渲染」反模式。

**Architecture:** 一个 `createThreadSliceFamily(rootAtom)` helper 封装 Phase 2d 的 `atomFamily(threadId => selectAtom(rootAtom, s => s[threadId]))` 模式，返回 `T | undefined`。依赖写入侧不可变展开（`{ ...prev, [id]: next }`）保留未变 threadId 的 value 引用 → `selectAtom` + `Object.is` 跳过重渲染。6 处单线程下标读取直接换 family（形状 A）；`LeftSidebar` 整对象读改由 `memo` 的 `ThreadItem` 行级订阅（形状 B，性能收益落点）。

**Tech Stack:** TypeScript、React、jotai 2.19（`atomFamily`/`selectAtom` from `jotai/utils`，`Provider`/`createStore`/`atom` from `jotai`）、bun:test、@testing via `react-dom/client` createRoot + `act`。

## Global Constraints

- 分支 `feat/new-ui`，**勿合并 main**（长期开发分支，后续还有 Phase 5-10）。每个 Task 末尾 commit。
- jotai 2.19.1：`atomFamily`、`selectAtom` 从 `jotai/utils` 导入；`createStore`、`Provider` 从 `jotai` 导入。
- **写入侧不得引入 mutation**：所有 root atom setter 必须保持 `{ ...prev, [id]: next }` 不可变展开（已核实现状如此；本计划不改任何写入侧）。
- **零回归基线**（pass/fail 数须与基线一致，pre-existing fail 不算回归）：
  - memory-v2：147 pass / 0 fail（无关域，仅确认未误碰）
  - AgentMessages 单独跑：30 pass / 0 fail
  - agent 目录：117 pass / 23 fail / 18 errors（pre-existing：desktop-api 导出缺失）
  - app-shell 目录：改前先记录基线数（当前 `LumeSidebar.test.tsx` 2 pass、`lume-sidebar-view-model.test.ts` 8 pass）
  - projection：26 pass / 1 fail（pre-existing：compaction notice test 过时）
  - typecheck：`bun run --filter @lume/web typecheck` exit 0
- 范围 YAGNI：不回收改造 Phase 2d 的 `agentRuntimeEventsFamily`；不碰 storage 类 atom（`agentSidePanelViewAtom`/`agentFileTreeOpenAtom`）与 Tier-3 低频 atom（`agentMessageQueueAtom`/`agentErrorMessagesAtom`/`agentThreadPermissionModesAtom`）；**不删除任何 root atom 声明**（写入侧仍引用）。

## File Structure

| 文件 | 责任 | 本计划改动 |
|------|------|-----------|
| `apps/web/src/atoms/agent-atoms.ts` | 全局 atom 定义 | + helper `createThreadSliceFamily` + 5 个 family |
| `apps/web/src/atoms/agent-atoms.test.ts` | helper 契约测试（新建） | 新增：Object.is 引用稳定性 + undefined 切片 |
| `apps/web/src/components/agent/AgentView.tsx` | 单线程视图 | 形状 A：streamingStates + pendingInteractive |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入栏 | 形状 A：planModePhase |
| `apps/web/src/components/agent/AgentHeader.tsx` | 头部 | 形状 A：runtimeStatus |
| `apps/web/src/components/agent/SubagentInlinePanel.tsx` | 子 agent 面板 | 形状 A：subagentRuns |
| `apps/web/src/components/app-shell/ThreadItem.tsx` | 线程行（memo） | 形状 B：行级订阅 family + 新测试 |
| `apps/web/src/components/app-shell/ThreadItem.test.tsx` | ThreadItem 测试（新建） | 新增：streaming 指示点 TDD 守护 |
| `apps/web/src/components/app-shell/lume-sidebar-view-model.ts` | 侧栏纯视图模型 | 形状 B：剥离 `streamingStates` 入参与 `isStreaming` 字段 |
| `apps/web/src/components/app-shell/LeftSidebar.tsx` | 侧栏容器 | 形状 B：去整对象读 |
| `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts` | 视图模型测试 | 形状 B：去掉 `streamingStates` 入参与 `isStreaming` 断言 |
| `apps/web/src/components/app-shell/LumeSidebar.test.tsx` | 侧栏组件测试 | 形状 B：去掉 builder 调用的 `streamingStates` |
| `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md` | 进展交接 | 标记本项完成 |

---

### Task 1: `createThreadSliceFamily` helper + 5 families + 契约测试

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`（顶部 import + 5 处 root atom 后插入 family）
- Create: `apps/web/src/atoms/agent-atoms.test.ts`

**Interfaces:**
- Produces: `createThreadSliceFamily<T>(rootAtom): AtomFamily<(threadId: string) => Atom<T | undefined>>`；`agentStreamingStatesFamily`、`agentPendingInteractiveFamily`、`agentPlanModePhaseFamily`、`agentSubagentRunsFamily`、`agentRuntimeStatusFamily`。

- [ ] **Step 1: 写失败测试（helper 契约：Object.is 引用稳定性 + undefined 切片）**

创建 `apps/web/src/atoms/agent-atoms.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { SubagentRunRecord } from '@lume/shared'
import {
  agentStreamingStatesAtom,
  agentStreamingStatesFamily,
  agentSubagentRunsAtom,
  agentSubagentRunsFamily,
} from './agent-atoms'

describe('createThreadSliceFamily (per-threadId slice)', () => {
  test('unchanged threadId keeps its value reference → subscriber not notified', () => {
    const store = createStore()
    const runsA: SubagentRunRecord[] = []
    const runsB: SubagentRunRecord[] = []
    store.set(agentSubagentRunsAtom, { A: runsA, B: runsB })

    let calls = 0
    const unsub = store.sub(agentSubagentRunsFamily('A'), () => {
      calls += 1
    })

    // 仅改 B，A 的引用经 spread 保留 → 订阅者不被通知。
    store.set(agentSubagentRunsAtom, { ...store.get(agentSubagentRunsAtom), B: [] })
    expect(calls).toBe(0)

    // A 的切片换为新引用 → 订阅者被通知。
    store.set(agentSubagentRunsAtom, { ...store.get(agentSubagentRunsAtom), A: [] })
    expect(calls).toBe(1)

    unsub()
  })

  test('returns undefined for a threadId with no entry', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, { A: 'streaming' })

    expect(store.get(agentStreamingStatesFamily('nope'))).toBeUndefined()
    expect(store.get(agentStreamingStatesFamily('A'))).toBe('streaming')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/atoms/agent-atoms.test.ts`
Expected: FAIL — `agentStreamingStatesFamily` / `agentSubagentRunsFamily` 未导出（not exported）。

- [ ] **Step 3: 加 jotai 类型 import**

`apps/web/src/atoms/agent-atoms.ts` 顶部现有：

```ts
import { atom } from 'jotai'
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils'
```

改为：

```ts
import { atom, type Atom, type WritableAtom } from 'jotai'
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils'
```

- [ ] **Step 4: 实现 helper（放在 import 块之后、第一个 atom 之前）**

```ts
/**
 * 按 threadId 切片订阅一个全局 Record atom。
 * 返回 atomFamily：每个 threadId 一个 selectAtom，selector 返回 state[threadId]，
 * 经 Object.is 比较。依赖写入侧不可变展开（{ ...prev, [id]: next }）保留未变
 * threadId 的 value 引用 —— 否则 selectAtom 无法跳过重渲染。
 * 返回 T | undefined；调用方保留既有 `?? default` 语义。
 */
export function createThreadSliceFamily<T>(
  rootAtom: Atom<Record<string, T>> | WritableAtom<Record<string, T>, unknown[], unknown>,
) {
  return atomFamily((threadId: string) =>
    selectAtom(rootAtom, (state) => state[threadId]),
  )
}
```

- [ ] **Step 5: 紧邻每个 root atom 声明其 family**

在 `agent-atoms.ts` 中，每个 root atom 声明行之后插入对应 family：

`agentStreamingStatesAtom`（约第 10 行）之后追加：
```ts
export const agentStreamingStatesFamily = createThreadSliceFamily(agentStreamingStatesAtom)
```

`agentRuntimeStatusAtom`（约第 11 行）之后追加：
```ts
export const agentRuntimeStatusFamily = createThreadSliceFamily(agentRuntimeStatusAtom)
```

`agentPendingInteractiveAtom`（约第 21 行）之后追加：
```ts
export const agentPendingInteractiveFamily = createThreadSliceFamily(agentPendingInteractiveAtom)
```

`agentSubagentRunsAtom`（约第 23 行）之后追加：
```ts
export const agentSubagentRunsFamily = createThreadSliceFamily(agentSubagentRunsAtom)
```

`agentPlanModePhaseAtom`（约第 25 行）之后追加：
```ts
export const agentPlanModePhaseFamily = createThreadSliceFamily(agentPlanModePhaseAtom)
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test apps/web/src/atoms/agent-atoms.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 7: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/atoms/agent-atoms.ts apps/web/src/atoms/agent-atoms.test.ts
git commit -m "♻️ refactor(web): createThreadSliceFamily helper + 5 个 per-threadId 切片 family + 契约测试"
```

---

### Task 2: 形状 A — AgentView（streamingStates + pendingInteractive）

**Files:**
- Modify: `apps/web/src/components/agent/AgentView.tsx`（import + 第 41、42 行）

**Interfaces:**
- Consumes: Task 1 的 `agentStreamingStatesFamily`、`agentPendingInteractiveFamily`。

- [ ] **Step 1: 改 import**

`AgentView.tsx` 现有 import（从 `@/atoms`）含 `agentStreamingStatesAtom`、`agentPendingInteractiveAtom`。把这两项替换为 family：

```ts
agentStreamingStatesAtom   →  agentStreamingStatesFamily
agentPendingInteractiveAtom → agentPendingInteractiveFamily
```
（其余 import 项保持不变；保持字母序与既有风格。）

- [ ] **Step 2: 改两处读取**

第 41 行：
```ts
// 旧
const streamingState = useAtomValue(agentStreamingStatesAtom)[threadId] ?? 'idle'
// 新
const streamingState = useAtomValue(agentStreamingStatesFamily(threadId)) ?? 'idle'
```

第 42 行：
```ts
// 旧
const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)[threadId]
// 新
const pendingInteractive = useAtomValue(agentPendingInteractiveFamily(threadId))
```

- [ ] **Step 3: 跑 AgentView 测试（回归门）**

Run: `bun test apps/web/src/components/agent/AgentView.test.tsx`
Expected: PASS（维持基线 pass 数；该文件以 `Provider + createStore` 种子 atom，行为不变）。

- [ ] **Step 4: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentView.tsx
git commit -m "⚡️ perf(web): AgentView streamingStates/pendingInteractive 改按 threadId 切片订阅"
```

---

### Task 3: 形状 A — AgentInput + AgentHeader + SubagentInlinePanel

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx:207`（planModePhase）
- Modify: `apps/web/src/components/agent/AgentHeader.tsx:24`（runtimeStatus）
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx:31,41`（subagentRuns）

**Interfaces:**
- Consumes: Task 1 的 `agentPlanModePhaseFamily`、`agentRuntimeStatusFamily`、`agentSubagentRunsFamily`。

- [ ] **Step 1: AgentInput — planModePhase**

import：把 `agentPlanModePhaseAtom` 替换为 `agentPlanModePhaseFamily`（从 `@/atoms`，其余项不变）。
第 207 行：
```ts
// 旧
const planModePhase = useAtomValue(agentPlanModePhaseAtom)[threadId]
// 新
const planModePhase = useAtomValue(agentPlanModePhaseFamily(threadId))
```

- [ ] **Step 2: AgentHeader — runtimeStatus**

import：把 `agentRuntimeStatusAtom` 替换为 `agentRuntimeStatusFamily`。
第 24 行：
```ts
// 旧
const runtimeStatus = useAtomValue(agentRuntimeStatusAtom)[threadId]
// 新
const runtimeStatus = useAtomValue(agentRuntimeStatusFamily(threadId))
```

- [ ] **Step 3: SubagentInlinePanel — subagentRuns**

import：把 `agentSubagentRunsAtom` 替换为 `agentSubagentRunsFamily`，并确保已 import `useAtomValue`（若原 import 含 `useAtomValue` 则保留）。
第 31 行删除整对象读、第 41 行改 family：
```ts
// 旧（第 31 行）
const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)
// 旧（第 41 行）
const runs = subagentRunsMap[threadId] ?? []
// 新（删除第 31 行；第 41 行改为）
const runs = useAtomValue(agentSubagentRunsFamily(threadId)) ?? []
```

- [ ] **Step 4: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 5: agent 目录回归门**

Run: `bun test apps/web/src/components/agent/`
Expected: 117 pass / 23 fail / 18 errors（与基线一致；pre-existing desktop-api 缺失不计回归）。同时单独确认 AgentMessages：
Run: `bun test apps/web/src/components/agent/AgentMessages.test.tsx`
Expected: 30 pass / 0 fail。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/SubagentInlinePanel.tsx
git commit -m "⚡️ perf(web): AgentInput/AgentHeader/SubagentInlinePanel 切片订阅（planModePhase/runtimeStatus/subagentRuns）"
```

---

### Task 4: 形状 B（上）— ThreadItem 行级订阅 family（TDD）

**Files:**
- Create: `apps/web/src/components/app-shell/ThreadItem.test.tsx`
- Modify: `apps/web/src/components/app-shell/ThreadItem.tsx`（import + 组件内订阅 + 第 105、109 行）

**Interfaces:**
- Consumes: Task 1 的 `agentStreamingStatesFamily`。
- 依赖：`Provider`、`createStore` from `jotai`（参考 `AgentView.test.tsx` 模式）。

> 说明：本 Task 让 `ThreadItem` 改从 family 订阅 streaming 状态，但**暂不动**视图模型（`thread.isStreaming` 字段仍在类型中、builder 仍产出，ThreadItem 只是不再用它）。Task 5 再清理视图模型与 `LeftSidebar` 的整对象读。这样每步可独立测试、独立提交。

- [ ] **Step 1: 写失败测试（streaming 指示点由 family 决定）**

创建 `apps/web/src/components/app-shell/ThreadItem.test.tsx`：

```tsx
import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { ThreadItem } from './ThreadItem'
import { agentStreamingStatesAtom } from '@/atoms'
import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

function makeThread(): LumeSidebarThreadItem {
  return {
    id: 't1',
    title: '线程一',
    active: false,
    pinned: false,
    updatedAt: 0,
  } as unknown as LumeSidebarThreadItem
}

function renderHTML(streaming: boolean): string {
  const store = createStore()
  store.set(agentStreamingStatesAtom, { t1: streaming ? 'streaming' : 'idle' })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <Provider store={store}>
        <ThreadItem
          thread={makeThread()}
          onSelect={() => {}}
          onTogglePin={() => {}}
          onArchive={() => {}}
          onRename={() => {}}
        />
      </Provider>,
    )
  })
  const html = container.innerHTML
  act(() => {
    root.unmount()
  })
  container.remove()
  return html
}

describe('ThreadItem streaming indicator', () => {
  test('shows pulse dot when the thread is streaming', () => {
    expect(renderHTML(true).includes('animate-pulse')).toBe(true)
  })

  test('hides indicator when the thread is idle and not active', () => {
    expect(renderHTML(false).includes('animate-pulse')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/components/app-shell/ThreadItem.test.tsx`
Expected: FAIL —— 当前 `ThreadItem` 读 `thread.isStreaming`（prop），忽略 store；`makeThread()` 未设 isStreaming → 两 case 均无 `animate-pulse`，第一个 test 失败。

- [ ] **Step 3: 改 ThreadItem 订阅 family**

`ThreadItem.tsx` 顶部 import 增加（紧随现有 react import 之后）：
```ts
import { useAtomValue } from 'jotai'
import { agentStreamingStatesFamily } from '@/atoms'
```

组件内（`export const ThreadItem = memo(function ThreadItem({ ... }: ThreadItemProps) {` 之后第一行，`const [editing, ...` 之前）插入：
```ts
  const streamingState = useAtomValue(agentStreamingStatesFamily(thread.id))
  const isStreaming = streamingState === 'streaming'
```

第 105 行：
```tsx
// 旧
{(thread.isStreaming || thread.active) && (
// 新
{(isStreaming || thread.active) && (
```

第 109 行：
```tsx
// 旧
thread.isStreaming ? 'bg-blue-500 animate-pulse' : 'bg-[var(--brand)]',
// 新
isStreaming ? 'bg-blue-500 animate-pulse' : 'bg-[var(--brand)]',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/components/app-shell/ThreadItem.test.tsx`
Expected: PASS（2 tests）。

- [ ] **Step 5: app-shell 回归门 + typecheck**

Run: `bun test apps/web/src/components/app-shell/`
Expected: 既有用例全绿（`LumeSidebar.test.tsx` 2、`lume-sidebar-view-model.test.ts` 8，加新增 2）。
Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/app-shell/ThreadItem.tsx apps/web/src/components/app-shell/ThreadItem.test.tsx
git commit -m "♻️ refactor(web): ThreadItem streaming 指示点改订阅 family（TDD 守护）"
```

---

### Task 5: 形状 B（下）— 视图模型剥离 streamingStates，LeftSidebar 去整对象读

**Files:**
- Modify: `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`（接口 + builder + `buildThreadItem`）
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`（去读 + 去 import + 去 builder 实参）
- Modify: `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`（去入参 + 去 isStreaming 断言 + 去 unused import）
- Modify: `apps/web/src/components/app-shell/LumeSidebar.test.tsx`（去 builder `streamingStates`）

**Interfaces:**
- `BuildLumeSidebarViewModelInput` 删除 `streamingStates` 字段。
- `LumeSidebarThreadItem` 删除 `isStreaming` 字段（由 `ThreadItem` 自 family 派生）。

- [ ] **Step 1: 视图模型 — 删 `streamingStates` 入参与 `isStreaming` 字段**

`lume-sidebar-view-model.ts`：

1. `BuildLumeSidebarViewModelInput`（约第 8-16 行）删除字段：
```ts
// 删除该行
streamingStates: Record<string, AgentRuntimePhase | undefined>
```

2. `buildLumeSidebarViewModel`（约第 88 行起的解构，约第 93 行）删除：
```ts
// 删除该行
streamingStates,
```

3. `LumeSidebarThreadItem`（约第 32-37 行）删除字段：
```ts
// 删除该行
isStreaming: boolean
```

4. 两处 `buildThreadItem(thread, activeTabId, streamingStates)`（约第 127、157 行）改为去掉第三参：
```ts
// 新
buildThreadItem(thread, activeTabId)
```

5. `buildThreadItem` 签名（约第 208-211 行）删除 `streamingStates` 形参与 `isStreaming` 派生：
```ts
// 旧签名（示意）
function buildThreadItem(
  thread: AgentThreadMeta,
  activeTabId: string | null,
  streamingStates: Record<string, AgentRuntimePhase | undefined>,
): LumeSidebarThreadItem {
  return {
    id: thread.id,
    ...
    active: activeTabId === thread.id,
    isStreaming: streamingStates[thread.id] === 'streaming',
    ...
  }
}
// 新签名
function buildThreadItem(
  thread: AgentThreadMeta,
  activeTabId: string | null,
): LumeSidebarThreadItem {
  return {
    id: thread.id,
    ...
    active: activeTabId === thread.id,
    ...   // isStreaming 行整行删除
    ...
  }
}
```
（执行时 Read 该函数体，逐字保留除 `streamingStates` 形参与 `isStreaming` 行之外的所有字段。）

6. 若 `AgentRuntimePhase` 的 import 因此变为未使用，删除该 import。

- [ ] **Step 2: LeftSidebar — 去整对象读**

`LeftSidebar.tsx`：

1. 删除第 39 行：
```ts
// 删除
const streamingStates = useAtomValue(agentStreamingStatesAtom)
```
2. import 块（从 `@/atoms`）删除 `agentStreamingStatesAtom`；若 `useAtomValue` 因此未使用则一并删。
3. `buildLumeSidebarViewModel({ ... })` 调用（约第 78-84 行）删除实参：
```ts
// 删除该行
streamingStates,
```

- [ ] **Step 3: 更新 `lume-sidebar-view-model.test.ts`**

1. 第 2 行 import 删除 `AgentRuntimePhase`（已无引用）：
```ts
// 旧
import type { AgentThreadMeta, AgentWorkspace, AgentRuntimePhase } from '@lume/shared'
// 新
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'
```
2. 全部 8 处 `buildLumeSidebarViewModel({ ... })` 调用删除 `streamingStates: {}` 或 `streamingStates: { ... }` 字段（含第 152-155 行的 `'thread-yesterday': 'streaming' satisfies AgentRuntimePhase` 整段）。
3. 第 160-165 行 `toMatchObject` 删除 `isStreaming: true`：
```ts
// 旧
expect(automationWorkspace?.threads[0]).toMatchObject({
  id: 'thread-yesterday',
  title: '昨天的线程',
  active: true,
  isStreaming: true,
})
// 新
expect(automationWorkspace?.threads[0]).toMatchObject({
  id: 'thread-yesterday',
  title: '昨天的线程',
  active: true,
})
```
4. 第 276-285 行 `toEqual` 删除 `isStreaming: false`：
```ts
// 旧
expect(firstUnassigned?.threads).toEqual([
  {
    id: 'legacy-thread',
    title: 'Legacy thread',
    active: false,
    pinned: false,
    isStreaming: false,
    updatedAt: threads[0].updatedAt,
  },
])
// 新
expect(firstUnassigned?.threads).toEqual([
  {
    id: 'legacy-thread',
    title: 'Legacy thread',
    active: false,
    pinned: false,
    updatedAt: threads[0].updatedAt,
  },
])
```

- [ ] **Step 4: 更新 `LumeSidebar.test.tsx`**

第 52-59 行 `buildLumeSidebarViewModel({ ... })` 调用删除：
```ts
// 删除该行
streamingStates: {},
```

- [ ] **Step 5: 跑 app-shell 全量 + typecheck**

Run: `bun test apps/web/src/components/app-shell/`
Expected: PASS（`LumeSidebar.test.tsx` 2、`lume-sidebar-view-model.test.ts` 8、`ThreadItem.test.tsx` 2；无新增 fail）。
Run: `bun run --filter @lume/web typecheck`
Expected: exit 0（确认 `LumeSidebarThreadItem.isStreaming` 删除后无残留引用 —— `ThreadItem` 已在 Task 4 改用本地 `isStreaming`）。

- [ ] **Step 6: Commit（性能收益落点）**

```bash
git add apps/web/src/components/app-shell/lume-sidebar-view-model.ts apps/web/src/components/app-shell/LeftSidebar.tsx apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts apps/web/src/components/app-shell/LumeSidebar.test.tsx
git commit -m "⚡️ perf(web): LeftSidebar 去整对象读 streamingStates，视图模型剥离 isStreaming（消除跨线程侧栏重渲染）"
```

---

### Task 6: 全量零回归核验 + 更新进展交接文档

**Files:**
- Modify: `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`

- [ ] **Step 1: 全量基线核验**

依次运行，确认每项 pass/fail 与 Global Constraints 基线一致：
```bash
bun test apps/sidecar/src/services/memory-v2/            # 147 pass / 0 fail
bun test apps/web/src/components/agent/AgentMessages.test.tsx   # 30 pass / 0 fail
bun test apps/web/src/components/agent/                  # 117 pass / 23 fail / 18 errors
bun test apps/web/src/components/app-shell/              # 新增 ThreadItem 2，余者不变
bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts  # 26 pass / 1 fail
bun run --filter @lume/web typecheck                    # exit 0
```
Expected：全部与基线一致（pre-existing fail 不计回归）。

- [ ] **Step 2: 更新进展交接文档**

`docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`：
1. 「一句话状态」段：把「8 个全局 atom 待做」改为「全局 atom 切片订阅已完成（5 个），剩余 Phase 5-10」。
2. 新增一行到「已完成 Phase 详情」表（表格末尾），记录本项：helper + 5 family + 形状 A/B，验收 = helper 契约测试 + 各基线零回归。
3. 「剩余工作」段：从「🥇 优先：其他全局 Record atom」移除已完成的 5 个，保留 storage atom + Tier-3 atom 为后续可选项（标注「按需」）。
4. 「test 基线」表：app-shell 行补记新增 `ThreadItem.test.tsx` 2、`agent-atoms.test.ts` 2。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-22-perf-progress-handoff.md
git commit -m "📝 docs(perf): 全局 atom 按 threadId 切片订阅完成，更新进展交接文档"
```

---

## Self-Review

**1. Spec coverage（逐条对照 spec）：**
- helper `createThreadSliceFamily` → Task 1 ✓
- 5 family → Task 1 Step 5 ✓
- 形状 A 6 处（AgentView×2、AgentInput、AgentHeader、SubagentInlinePanel）→ Task 2 + Task 3 ✓
- 形状 B（ThreadItem 订阅 + 视图模型剥离 + LeftSidebar 去读 + 两测试更新）→ Task 4 + Task 5 ✓
- helper 契约测试 → Task 1 ✓；ThreadItem TDD 测试 → Task 4 ✓
- 零回归基线 → Task 5 Step 5（局部）+ Task 6 Step 1（全量）✓
- 非目标（不回收 agentRuntimeEventsFamily / 不碰 storage / Tier-3 / 不删 root）→ Global Constraints 约束，无 Task 触及 ✓
无遗漏。

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 均给出实际代码或精确 before→after；视图模型函数体因字段多采用「逐字保留除 X 外」+ Read 指引（执行时读原文，非占位）。✓

**3. Type consistency：** family 命名全程一致（`agentStreamingStatesFamily` / `agentPendingInteractiveFamily` / `agentPlanModePhaseFamily` / `agentSubagentRunsFamily` / `agentRuntimeStatusFamily`）；`LumeSidebarThreadItem.isStreaming` 在 Task 5 删除，而 Task 4 已先把 `ThreadItem` 改用本地 `isStreaming` —— 顺序正确，无残留引用；Task 4 测试用 `as unknown as LumeSidebarThreadItem` 构造，Task 5 删字段后测试不受影响。✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-perf-fe-thread-slice-atoms.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每 Task 派一个 fresh subagent，Task 间 review，迭代快。
2. **Inline Execution** — 本会话内用 executing-plans 批量执行，带 checkpoint 复核。

Which approach?
