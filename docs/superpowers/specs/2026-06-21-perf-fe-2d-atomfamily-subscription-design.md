# Phase 2d 设计：agentRuntimeEventsFamily（atomFamily(selectAtom) 订阅粒度）

> **所属**：性能优化路线图 Phase 2 的订阅粒度优化。Phase 2 的 projection/stabilize/memo 链路（2a/2b/2c）已完成；2d 解决订阅层跨线程 re-render。其他 8 个全局 Record atom（streamingStates/pendingInteractive 等低频）拆后续。
>
> **前置**：2b（增量 projection）、2c（reconcile/stabilize/memo 引用稳定）已完成。

## 背景与动机

`agentRuntimeEventsAtom`（agent-atoms.ts:12）是全局 `Record<threadId, RuntimeEventState>`。组件通过 `useAtomValue(agentRuntimeEventsAtom)[threadId]?.events` 订阅 —— 在组件内切片，但 jotai 的 useAtomValue 订阅**整个 atom**。

`appendRuntimeEvent`/`hydrateRuntimeEvents`（runtime-event-state.ts）每次更新返回 `{...prev, [threadId]: new}` —— 整个 Record 对象引用变 → **所有订阅该 atom 的组件 re-render**，即使该组件只关心别的 threadId。

流式场景：线程 A 每 token 输出 → setRuntimeEvents → Record 引用变 → 线程 B 的 AgentMessages/Header/Input/TracePanel/TaskProgressPanel 全部 re-render（每 token）。这是多线程场景的主要 re-render 开销。

## Goal

让组件按 threadId 切片订阅 runtime events：线程 A 输出只触发订阅线程 A 的组件 re-render，订阅线程 B 的组件不 re-render。

## 关键洞察

`appendRuntimeEvent` 返回 `{...prev, [event.threadId]: {新对象}}`：
- 目标 threadId：新对象
- **其他 threadId**：`...prev` 复制，value 是 `prev[otherId]`（**同引用**）

因此 `selectAtom(agentRuntimeEventsAtom, state => state[myThreadId])` + Object.is 比较：未变 threadId 的切片引用不变 → 不通知订阅者 → 不 re-render。**写入逻辑零改动**，只改读取。

## Architecture

```
useGlobalAgentListeners (写) ─setRuntimeEvents─▶ agentRuntimeEventsAtom (全局 Record)
                                                      │
                                  agentRuntimeEventsFamily = atomFamily(threadId =>
                                    selectAtom(agentRuntimeEventsAtom, state => state[threadId]))
                                                      │ (按 threadId 切片，Object.is 比较)
              ┌───────────┬───────────┬───────────┬───────────┬───────────┐
         AgentHeader  AgentInput  AgentMessages  TracePanel  TaskProgressPanel
         (family(A))  (family(A))  (family(A))   (family(A))   (family(A))
```

线程 B 更新 → Record 引用变 → family(B) 的 selectAtom 切片变（B 新对象）→ 订阅 family(B) 的组件 re-render；family(A) 的 selectAtom 切片引用不变（A 的 value 同引用）→ 订阅 family(A) 的组件**不 re-render**。

## 改动详情

### 改动 1：agentRuntimeEventsFamily（agent-atoms.ts）

```ts
import { atom, atomFamily } from 'jotai'
import { atomWithStorage, selectAtom } from 'jotai/utils'
// ...
export const agentRuntimeEventsAtom = atom<RuntimeEventState>({})

/**
 * 按 threadId 切片订阅 runtime events。selectAtom + Object.is 比较：
 * appendRuntimeEvent 对未变 threadId 保留 value 引用 → 未变线程的组件不 re-render。
 */
export const agentRuntimeEventsFamily = atomFamily((threadId: string) =>
  selectAtom(agentRuntimeEventsAtom, (state) => state[threadId]),
)
```

从 `@/atoms` barrel 导出（组件 import 来源）。

### 改动 2：5 个读点改用 family

| 文件 | 现状 | 改后 |
|---|---|---|
| AgentHeader.tsx:25 | `useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []` | `useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []` |
| AgentInput.tsx:208 | 同上 | 同上（保留 `useSetAtom(agentRuntimeEventsAtom)` 写） |
| AgentMessages.tsx:45 | 同上 | 同上（保留写） |
| TracePanel.tsx:31 | `useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []` | `useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []` |
| TaskProgressPanel.tsx:58 | `useAtomValue(agentRuntimeEventsAtom)[threadId]` | `useAtomValue(agentRuntimeEventsFamily(threadId))` |

import 调整：
- AgentHeader / TracePanel / TaskProgressPanel（只读）：import `agentRuntimeEventsFamily` 替 `agentRuntimeEventsAtom`
- AgentInput / AgentMessages（读+写）：import 两者 —— `agentRuntimeEventsAtom`（写）+ `agentRuntimeEventsFamily`（读）

### 写入零改动

4 处 `useSetAtom(agentRuntimeEventsAtom)`（AgentInput/AgentMessages/WelcomeView/useGlobalAgentListeners）+ `appendRuntimeEvent`/`appendRuntimeEvents`/`hydrateRuntimeEvents` 全部不动。

## test 策略

- **现有回归**（等价性守护 —— 订阅方式改变不破坏功能）：
  - projection test：26 pass / 1 fail（pre-existing compaction）
  - AgentMessages test：30 pass / 0 fail
  - agent 目录：117 pass / 23 fail / 18 errors（= 2b/2c 基线，全 pre-existing）
- **typecheck**：atomFamily/selectAtom 类型正确，5 个读点 import/用法类型对。
- **跨线程 re-render 隔离**：jotai selectAtom Object.is 标准行为保证；人工 React DevTools Profiler 验证（线程 A 输出时，线程 B 组件 render count 不增）。不写自动化 re-render test（避免 createRoot + 计数组件的复杂度，收益与 jotai 标准行为的确定性不匹配）。

## 范围边界（YAGNI）

**包含**：agentRuntimeEventsAtom 的 atomFamily(selectAtom) + 5 读点改。

**不包含**：
- 其他 8 个全局 Record atom（agentStreamingStatesAtom/agentPendingInteractiveAtom/agentPlanModePhaseAtom/agentSubagentRunsAtom/agentRuntimeStatusAtom/agentMessageQueueAtom/agentErrorMessagesAtom/agentThreadPermissionModesAtom）—— 低频更新，跨线程 re-render 开销小，拆后续（可复用同样模式或抽 `createThreadSliceFamily` helper）。
- atomFamily 清理（family.remove）：threadId 数量有限（用户线程数），缓存累积可忽略。YAGNI。
- 自动化 re-render test。

## 风险

1. **selectAtom selector 稳定性**：selector `(state) => state[threadId]` 返回 Record value 引用，不创建新对象 → Object.is 比较有效。需确认 selector 不在内部创建新对象（它没有）。✓
2. **AgentMessages 的增量 projection 兼容**：2b/2c 的 projectionRef/reconcileCacheRef 基于 `runtimeEvents` 数组引用。family(threadId) 返回 ThreadRuntimeEventState，组件取 `.events`。runtimeEvents 数组引用由 appendRuntimeEvents 追加语义保证（不变），family 不影响（只改订阅来源，值不变）。✓
3. **atomFamily 缓存**：每个 threadId 一个 selectAtom，缓存在 atomFamily 内部。threadId 数量有限，无泄漏风险。✓
4. **写端不变的正确性**：appendRuntimeEvent 仍操作全局 Record；family 的 selectAtom 读全局 Record 的切片。读写通过全局 atom 协调，一致。✓
