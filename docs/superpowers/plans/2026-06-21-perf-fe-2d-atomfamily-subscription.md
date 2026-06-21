# Phase 2d：agentRuntimeEventsFamily（atomFamily(selectAtom) 订阅粒度）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 2 订阅粒度优化。2a/2b/2c（projection/stabilize/memo 引用稳定）已完成。本 plan 解决订阅层跨线程 re-render。设计依据：`docs/superpowers/specs/2026-06-21-perf-fe-2d-atomfamily-subscription-design.md`。

**Goal:** 让组件按 threadId 切片订阅 runtime events —— 线程 A 输出只触发订阅线程 A 的组件 re-render，订阅线程 B 的组件不 re-render。

**Architecture:** `agentRuntimeEventsFamily = atomFamily(threadId => selectAtom(agentRuntimeEventsAtom, state => state[threadId]))`。selectAtom + Object.is 按 threadId 切片比较；`appendRuntimeEvent` 对未变 threadId 保留 value 引用 → 未变线程组件不 re-render。**写入零改动**（仍 set 全局 atom），只改 5 个读点。

**Tech Stack:** jotai（atomFamily + selectAtom，均 jotai/utils 或 jotai）+ React 18 + TypeScript + bun:test。无新依赖。

**审查依据:** `agent-atoms.ts:12`（agentRuntimeEventsAtom 定义）、`runtime-event-state.ts:13-30`（appendRuntimeEvent 返回 `{...prev, [threadId]: new}`，未变 threadId value 同引用）、5 读点（AgentHeader.tsx:25 / AgentInput.tsx:208 / AgentMessages.tsx:45 / TracePanel.tsx:31 / TaskProgressPanel.tsx:58）、4 写点（AgentInput.tsx:209 / AgentMessages.tsx:46 / WelcomeView.tsx:65 / useGlobalAgentListeners.ts:45，全部不动）。

**test 策略（无新 test）:** 2d 是 jotai 标准重构，等价性由现有回归守护（projection 26/1 + AgentMessages 30/0 + agent 目录 117/23/18），类型由 typecheck 守护。跨线程 re-render 隔离是 jotai selectAtom Object.is 标准行为，人工 DevTools 验证（不写自动化 re-render test）。

---

## File Structure

- Modify: `apps/web/src/atoms/agent-atoms.ts` — 新增 `agentRuntimeEventsFamily`（atomFamily + selectAtom），调整 import（atomFamily from jotai、selectAtom from jotai/utils）。
- Modify: `apps/web/src/atoms/index.ts`（barrel）— 导出 `agentRuntimeEventsFamily`。
- Modify: `apps/web/src/components/agent/AgentHeader.tsx` — 读点改 family + import 调整。
- Modify: `apps/web/src/components/agent/AgentInput.tsx` — 读点改 family + import 加 family（保留 atom 写）。
- Modify: `apps/web/src/components/agent/AgentMessages.tsx` — 读点改 family + import 加 family（保留 atom 写）。
- Modify: `apps/web/src/components/agent/TracePanel.tsx` — 读点改 family + import 调整。
- Modify: `apps/web/src/components/agent/TaskProgressPanel.tsx` — 读点改 family + import 调整。
- 不改：4 写点（useSetAtom(agentRuntimeEventsAtom)）、runtime-event-state.ts（append/hydrate）、projection/stabilize/memo（2a/2b/2c）、其他 8 个全局 atom。

---

## Task 1：agentRuntimeEventsFamily 实现

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`
- Modify: `apps/web/src/atoms/index.ts`

- [ ] **Step 1: agent-atoms.ts 调整 import + 新增 family**

当前 `agent-atoms.ts:1-4` import：
```ts
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanModePhaseChangedEvent, AgentSendInput, AgentMessageQueueSnapshot } from '@lume/shared'
import type { RuntimeEventState } from '@/hooks/runtime-event-state'
```

改为（加 `atomFamily` from jotai、`selectAtom` from jotai/utils）：
```ts
import { atom, atomFamily } from 'jotai'
import { atomWithStorage, selectAtom } from 'jotai/utils'
import type { AgentThreadMeta, AgentRuntimeStatus, AgentPendingInteractiveState, SubagentRunRecord, PlanModePhaseChangedEvent, AgentSendInput, AgentMessageQueueSnapshot } from '@lume/shared'
import type { RuntimeEventState } from '@/hooks/runtime-event-state'
```

在 `agentRuntimeEventsAtom` 定义（line 12）之后新增 family：
```ts
export const agentRuntimeEventsAtom = atom<RuntimeEventState>({})

/**
 * 按 threadId 切片订阅 runtime events。selectAtom + Object.is 比较：
 * appendRuntimeEvent 对未变 threadId 保留 value 引用 → 未变线程的组件不 re-render。
 */
export const agentRuntimeEventsFamily = atomFamily((threadId: string) =>
  selectAtom(agentRuntimeEventsAtom, (state) => state[threadId]),
)
```

> selectAtom 的 selector `(state) => state[threadId]` 返回 Record value 引用（ThreadRuntimeEventState | undefined），不创建新对象 → Object.is 比较有效。atomFamily 缓存每个 threadId 的 selectAtom。

- [ ] **Step 2: atoms/index.ts barrel 导出 family**

读 `apps/web/src/atoms/index.ts`，找到 `agentRuntimeEventsAtom` 的 re-export 行（如 `export * from './agent-atoms'` 或显式 `export { agentRuntimeEventsAtom } from './agent-atoms'`）。

若是 `export * from './agent-atoms'`：family 自动导出，无需改动。确认即可。

若是显式列表：加 `agentRuntimeEventsFamily`：
```ts
export {
  // ...existing exports...
  agentRuntimeEventsAtom,
  agentRuntimeEventsFamily,
  // ...
} from './agent-atoms'
```

> 运行 `grep -n "agentRuntimeEventsAtom\|agent-atoms" apps/web/src/atoms/index.ts` 确认导出方式后决定是否改动。

- [ ] **Step 3: typecheck 确认 family 实现 + 导出正确**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0（family 定义 + 导出类型正确；此时读点还未改用 family，但 family 已导出可用）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/atoms/agent-atoms.ts apps/web/src/atoms/index.ts
git commit -m "⚡️ perf(web): agentRuntimeEventsFamily atomFamily(selectAtom) 按 threadId 切片订阅"
```

---

## Task 2：5 个读点改用 family

**Files:**
- Modify: `apps/web/src/components/agent/AgentHeader.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/TracePanel.tsx`
- Modify: `apps/web/src/components/agent/TaskProgressPanel.tsx`

- [ ] **Step 1: AgentHeader.tsx（只读）**

import（line 3）：`agentRuntimeEventsAtom` → `agentRuntimeEventsFamily`：
```ts
import { agentRuntimeEventsFamily, agentThreadsAtom, agentRuntimeStatusAtom } from '@/atoms'
```

读点（line 25）：
```ts
const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
```

- [ ] **Step 2: TracePanel.tsx（只读）**

import（line 4）：`agentRuntimeEventsAtom` → `agentRuntimeEventsFamily`：
```ts
import { agentRuntimeEventsFamily } from '@/atoms'
```

读点（line 31）：
```ts
const liveRuntimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
```

- [ ] **Step 3: TaskProgressPanel.tsx（只读）**

import（line 3）：`agentRuntimeEventsAtom` → `agentRuntimeEventsFamily`：
```ts
import { agentRuntimeEventsFamily } from '@/atoms'
```

读点（line 58）：
```ts
const runtimeEventState = useAtomValue(agentRuntimeEventsFamily(threadId))
```

- [ ] **Step 4: AgentInput.tsx（读 + 写）**

import（line 21）：保留 `agentRuntimeEventsAtom`（写用），加 `agentRuntimeEventsFamily`（读用）：
```ts
import { agentMessageQueueAtom, agentPlanModePhaseAtom, agentRuntimeEventsAtom, agentRuntimeEventsFamily, agentStreamingStatesAtom, agentThreadPermissionModesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
```

读点（line 208）：
```ts
const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
```

写点（line 209 `const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)`）**不动**。

- [ ] **Step 5: AgentMessages.tsx（读 + 写）**

import（line 4）：保留 `agentRuntimeEventsAtom`（写用），加 `agentRuntimeEventsFamily`（读用）：
```ts
import { agentRuntimeEventsAtom, agentRuntimeEventsFamily, agentSubagentRunsAtom } from '@/atoms'
```

读点（line 45）：
```ts
const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
```

写点（line 46 `const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)`）**不动**。

> AgentMessages 的 2b/2c 增量 projection（projectionRef）+ 2c reconcile/stabilize（reconcileCacheRef）基于 `runtimeEvents` 数组引用。family(threadId) 返回 ThreadRuntimeEventState，`.events` 取数组。runtimeEvents 数组引用由 appendRuntimeEvents 追加语义保证，family 只改订阅来源不改值 → 增量 projection/ref 完全兼容。

- [ ] **Step 6: typecheck 确认 5 读点改正确**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0（5 个读点 family(threadId) 用法 + import 类型正确）。

> 若 typecheck 报 `agentRuntimeEventsAtom` unused（AgentHeader/TracePanel/TaskProgressPanel 只读文件，改后不再 import atom）：移除该 unused import（这些文件只读，改后只用 family）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/TracePanel.tsx apps/web/src/components/agent/TaskProgressPanel.tsx
git commit -m "⚡️ perf(web): 5 读点改用 agentRuntimeEventsFamily，跨线程 re-render 隔离"
```

---

## Task 3：回归验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: 现有 test 回归（等价性守护）**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts 2>&1 | tail -3`
Expected: 26 pass / 1 fail（pre-existing compaction 不变）。

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts 2>&1 | tail -3`
Expected: 30 pass / 0 fail。

Run: `bun test apps/web/src/components/agent/ 2>&1 | tail -3`
Expected: 117 pass / 23 fail / 18 errors（= 2b/2c 基线，全 pre-existing desktop-api/overlay 问题）。

> 关键：订阅方式改变不破坏功能。fail/error 数不变 = 零回归。

- [ ] **Step 2: typecheck 全量**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 3: 调用方契约检查**

确认 family 改动未破坏消费方：
- 5 个读点：`useAtomValue(agentRuntimeEventsFamily(threadId))` 返回 `ThreadRuntimeEventState | undefined`，`.events ?? []` 或直接用（TaskProgressPanel）。与原 `useAtomValue(atom)[threadId]` 返回类型一致。✓
- 4 个写点：`useSetAtom(agentRuntimeEventsAtom)` 不变。✓
- AgentMessages 的 projectionRef（2b）/ reconcileCacheRef（2c）：消费 `runtimeEvents`（family 的 .events），值不变，ref 逻辑兼容。✓

- [ ] **Step 4: 隔离对比（可选，确认零回归）**

```bash
git log --oneline -3  # 确认本 plan commit 数（Task 1 + Task 2 = 2 commit）
git checkout HEAD~2 -- apps/web/src/atoms/agent-atoms.ts apps/web/src/atoms/index.ts apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/TracePanel.tsx apps/web/src/components/agent/TaskProgressPanel.tsx
bun test apps/web/src/components/agent/ 2>&1 | tail -3  # 2c 基线
git checkout HEAD -- apps/web/src/atoms/agent-atoms.ts apps/web/src/atoms/index.ts apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/TracePanel.tsx apps/web/src/components/agent/TaskProgressPanel.tsx  # 恢复
```
对比 fail/error 数。2d 后不应多于 2c 基线（117/23/18）。

- [ ] **Step 5: 人工 DevTools 验证（可选，留给真实环境）**

在多线程场景（线程 A 流式输出时，切到线程 B 查看），用 React DevTools Profiler 观察：线程 A 的 setRuntimeEvents 不应触发线程 B 的 AgentMessages/Header/Input/TracePanel/TaskProgressPanel re-render。验证后无需改动代码。

---

## 注意事项与边界

- **写入零改动是核心**：2d 只改订阅（读），不改状态形状（写）。appendRuntimeEvent/hydrateRuntimeEvents/useSetAtom 全部不动 → 写入逻辑零风险。
- **selectAtom Object.is 是 jotai 标准行为**：未变 threadId 的切片引用不变（appendRuntimeEvent 保证）→ 不通知订阅者。这是 jotai 文档保证的，非自实现。
- **无新 test**：2d 等价性由现有回归守护（订阅方式改变不破坏功能），类型由 typecheck 守护。跨线程隔离靠 jotai 标准行为 + 人工验证。
- **只 runtimeEvents**：其他 8 个全局 Record atom（低频）拆后续。本 plan 不碰。
- **atomFamily 缓存**：threadId 数量有限（用户线程数），无泄漏。不做 remove 清理（YAGNI）。
- **Surgical Changes**：只加 family + 改 5 读点 import/用法。不动 projection/stabilize/memo（2a/2b/2c）、不动写端、不动其他 atom。
