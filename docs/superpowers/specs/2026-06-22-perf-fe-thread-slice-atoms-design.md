# 前端性能：全局 Record atom 按 threadId 切片订阅（Phase 2d 模式推广）

> **日期**：2026-06-22
> **分支**：`feat/new-ui`（长期开发分支，勿合并 main）
> **前置**：Phase 2d 已落地 `agentRuntimeEventsFamily = atomFamily(threadId => selectAtom(...))` 参考实现。
> **路线图位置**：路线图「🥇 优先：其他全局 Record atom」项。承接 `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`。

## 一句话目标

把 5 个全局 `Record<string, T>` atom 改造成「按 threadId 切片订阅」，消除「线程 A 流式输出 → 线程 B 的 `AgentView` / 整个 `LeftSidebar` 重新渲染」反模式。手法与 Phase 2d 一致，复用为一个 `createThreadSliceFamily` helper。

## 反模式确认（基线事实）

全局 Record atom 被组件以**整对象读取后再按下标取值**的方式消费：

- `LeftSidebar.tsx:39` `useAtomValue(agentStreamingStatesAtom)` → 整对象传入纯函数 `buildLumeSidebarViewModel`，每个 `ThreadItem` 行的 `isStreaming` 由 `streamingStates[thread.id] === 'streaming'` 派生。→ **任一线程 streaming 变化 = 整个 `LeftSidebar` 重渲染 + 重建视图模型 + 所有线程行重渲染。**
- `AgentView.tsx:41` `useAtomValue(agentStreamingStatesAtom)[threadId] ?? 'idle'`、`:42` `useAtomValue(agentPendingInteractiveAtom)[threadId]`。
- `AgentInput.tsx:207` `useAtomValue(agentPlanModePhaseAtom)[threadId]`。
- `AgentHeader.tsx:24` `useAtomValue(agentRuntimeStatusAtom)[threadId]`。
- `SubagentInlinePanel.tsx:31` `useAtomValue(agentSubagentRunsAtom)`，`:41` `subagentRunsMap[threadId] ?? []`（单线程面板，但读了整对象）。

写入侧均为**不可变展开**（已核实 `useGlobalAgentListeners.ts:125/129/137/141` 等：`setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))`，`pendingInteractive` 走 `upsertPending*` / `removePending*Everywhere` 返回新对象）。展开天然保留未变 threadId 的 value 引用 —— 这是 `selectAtom` + `Object.is` 能跳过重渲染的前提。**前提成立，方案安全。**

## 方案决策

| 方案 | 评价 |
|------|------|
| **A. helper + 5 个新 family**（**采用**） | 一个 `createThreadSliceFamily` 统一封装 Phase 2d 两行模式；5 个 atom 摊薄 helper 成本；单一 `Object.is` 契约源。 |
| B. 每个 atom 内联 atomFamily | 重复 5 次 2 行模板；无统一契约点。 |
| C. helper + 回收改造 `agentRuntimeEventsFamily` | 最统一，但改动 Phase 2d 已提交、正常工作的 atom。**非目标**（Surgical Changes / YAGNI）。 |

采用 **A，不回收**。

## helper 设计

位置：`apps/web/src/atoms/agent-atoms.ts`（与 Phase 2d family 同文件）。

```ts
import { atom } from 'jotai'
import { atomFamily, selectAtom } from 'jotai/utils'
import type { Atom, WritableAtom } from 'jotai'

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

- 返回 `T | undefined`（与 Phase 2d 的 `agentRuntimeEventsFamily` 一致：`state[threadId]` 可能不存在）。
- 调用方各自保留默认值（`?? 'idle'`、`?? []`），**helper 不烘焙默认值**，避免每个 atom 默认值不同导致 API 复杂化。

## 5 个新 family

均在 `agent-atoms.ts`，紧邻对应 root atom 声明：

| family | root atom | 消费默认 |
|--------|-----------|----------|
| `agentStreamingStatesFamily` | `agentStreamingStatesAtom`（`Record<string, StreamingState>`） | `?? 'idle'` |
| `agentPendingInteractiveFamily` | `agentPendingInteractiveAtom` | 无（undefined 即「无 pending」） |
| `agentPlanModePhaseFamily` | `agentPlanModePhaseAtom` | 无 |
| `agentSubagentRunsFamily` | `agentSubagentRunsAtom` | `?? []` |
| `agentRuntimeStatusFamily` | `agentRuntimeStatusAtom` | 无 |

## 读点迁移（两种形状）

### 形状 A — 单线程下标读取（1 行替换，6 处）

| 文件:行 | 旧 | 新 |
|---------|----|----|
| `AgentView.tsx:41` | `useAtomValue(agentStreamingStatesAtom)[threadId] ?? 'idle'` | `useAtomValue(agentStreamingStatesFamily(threadId)) ?? 'idle'` |
| `AgentView.tsx:42` | `useAtomValue(agentPendingInteractiveAtom)[threadId]` | `useAtomValue(agentPendingInteractiveFamily(threadId))` |
| `AgentInput.tsx:207` | `useAtomValue(agentPlanModePhaseAtom)[threadId]` | `useAtomValue(agentPlanModePhaseFamily(threadId))` |
| `AgentHeader.tsx:24` | `useAtomValue(agentRuntimeStatusAtom)[threadId]` | `useAtomValue(agentRuntimeStatusFamily(threadId))` |
| `SubagentInlinePanel.tsx:31,41` | `const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)` → `map[threadId] ?? []` | `const runs = useAtomValue(agentSubagentRunsFamily(threadId)) ?? []`（删整对象读取） |

形状 A 删除每个文件对 root atom 的 import、改引 family。`agentRuntimeStatusAtom` / `agentPlanModePhaseAtom` / `agentPendingInteractiveAtom` 的 root 仍被 `useGlobalAgentListeners`（写入侧）引用，**不删除 root 声明**。

### 形状 B — 整对象 → 行级组件订阅（streamingStates，真正重构）

`ThreadItem` 已是 `memo` 包裹、持有 `thread.id`，正是按线程订阅的理想落点：

1. **`ThreadItem.tsx`**：`ThreadItemProps.thread` 持有 `thread.id`，新增 `const streamingState = useAtomValue(agentStreamingStatesFamily(thread.id))`，本地派生 `const isStreaming = streamingState === 'streaming'`，渲染处用本地 `isStreaming` 替换 `thread.isStreaming`（行 105、109）。
2. **`lume-sidebar-view-model.ts`**：
   - `BuildLumeSidebarViewModelInput`（行 8-16）删除 `streamingStates` 字段。
   - `buildLumeSidebarViewModel`（行 88）解构删除 `streamingStates`（行 93）。
   - `buildThreadItem(thread, activeTabId, streamingStates)`（行 127、157）去掉第三参。
   - `buildThreadItem` 签名（行 ~210）删 `streamingStates` 形参，`LumeSidebarThreadItem.isStreaming`（行 37、217）字段**移除**（改由 `ThreadItem` 本地派生）。
3. **`LeftSidebar.tsx`**：删 `const streamingStates = useAtomValue(agentStreamingStatesAtom)`（行 39）、删 `agentStreamingStatesAtom` import、删 `buildLumeSidebarViewModel` 调用的 `streamingStates,` 实参（行 83）。
4. **`LumeSidebar.test.tsx`**：删 `streamingStates: {}` mock（行 57）；视图模型 builder 若有快照测试同步去掉该字段。

## 验收（TDD + 零回归）

### 新增 helper 不变性测试（Phase 2d 等价性守护）

文件：`apps/web/src/atoms/agent-atoms.test.ts`（新建，若不存在）。用 `jotai/store` 的 `createStore`：

1. `store.sub(family('A'), cb)` 订阅线程 A 的切片。
2. 向 root atom 写入 `{ ...prev, B: newVal }`（线程 B 变） → 断言 `cb` **未被调用**（未变线程不重渲染）。
3. 写入 `{ ...prev, A: newVal }`（线程 A 变） → 断言 `cb` **被调用**。
4. 覆盖至少一个 family（如 `agentStreamingStatesFamily`）以验证通用 helper 装配正确。

此测试直接守护整个优化所依赖的 `Object.is` 契约。

### 零回归基线（护栏，pass/fail 数须与基线一致）

| 范围 | 基线 | 命令 |
|------|------|------|
| memory-v2（无关域，仅确认未误碰） | 147 pass / 0 fail | `bun test apps/sidecar/src/services/memory-v2/` |
| 前端 agent 目录 | 117 pass / 23 fail / 18 errors（pre-existing desktop-api 导出缺失） | `bun test apps/web/src/components/agent/` |
| AgentMessages（单独跑） | 30 pass / 0 fail | `bun test apps/web/src/components/agent/AgentMessages.test.ts` |
| LumeSidebar / app-shell | 现有数（改前先记录） | `bun test apps/web/src/components/app-shell/` |
| typecheck | exit 0 | `bun run --filter @lume/web typecheck` |

> pre-existing fail（desktop-api 导出缺失、overlay frame language）不算回归。

### 行为不变

- streaming 指示点仍仅对当前 streaming 的线程脉冲闪烁（`ThreadItem` 本地 `isStreaming` 派生等价于视图模型字段）。
- 无视觉差异；无功能变化。

## 风险

- **低**。模式 Phase 2d 已验证。
- 唯一非平凡处是 `LeftSidebar` 视图模型重构（形状 B）。由现有 `LumeSidebar.test.tsx` + helper 不变性测试守护。
- `selectAtom` 每次 root 变化都会跑 selector 并 `Object.is` 比较返回值；写入侧展开保证未变线程返回同引用 → 不触发。helper 测试覆盖此路径。

## 非目标（YAGNI）

- **不回收改造** Phase 2d 的 `agentRuntimeEventsFamily`（已工作、已提交）。
- **不碰** storage 类 atom（`agentSidePanelViewAtom`、`agentFileTreeOpenAtom`）—— `atomWithStorage` 机制不同，写入为用户驱动、低频，价值低。
- **不碰** Tier-3 低频 atom（`agentMessageQueueAtom`、`agentErrorMessagesAtom`、`agentThreadPermissionModesAtom`）—— 同模式但写入低频，留待后续按需。
- **不删除** root atom 声明（写入侧仍用）。

## 受影响文件清单

- `apps/web/src/atoms/agent-atoms.ts`（+ helper、+ 5 family）
- `apps/web/src/atoms/agent-atoms.test.ts`（+ 不变性测试，新建）
- `apps/web/src/components/app-shell/LeftSidebar.tsx`（形状 B）
- `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`（形状 B）
- `apps/web/src/components/app-shell/ThreadItem.tsx`（形状 B）
- `apps/web/src/components/app-shell/LumeSidebar.test.tsx`（形状 B mock）
- `apps/web/src/components/agent/AgentView.tsx`（形状 A ×2）
- `apps/web/src/components/agent/AgentInput.tsx`（形状 A）
- `apps/web/src/components/agent/AgentHeader.tsx`（形状 A）
- `apps/web/src/components/agent/SubagentInlinePanel.tsx`（形状 A）
