# Phase 1：前端流式渲染热路径优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"每个流式 token 触发一次全量 sort + setState"降到"每帧最多一次批量提交"，消除 Markdown 每帧重解析，使长流式输出期间主线程单帧 < 16ms。

**Architecture:** 三处独立、可叠加的局部优化——(1) `runtime-event-state.ts` 内部把 append 的无条件全量 `[...events].sort()` 改为"尾部有序即跳过"的增量路径；(2) 新增 `appendRuntimeEvents` 批量纯函数 + 在 `useGlobalAgentListeners` 用 `requestAnimationFrame` 合并一帧内的多个事件为一次 setState；(3) `useSmoothStream` 把 React `setState`（驱动 XMarkdown 重解析）与 rAF 字符累积解耦，按 flush 间隔限流。每处都用 characterization test（先固定现有行为）+ bench（量化提速）护栏。

**Tech Stack:** React 18 + jotai + bun:test + `requestAnimationFrame`（无需新依赖；`throttle-debounce` 已在 `apps/web/package.json`）。

**审查依据:** `useGlobalAgentListeners.ts:82`（每 token 写 atom）/ `runtime-event-state.ts:21,73`（每 append 全量 sort）/ `useSmoothStream.ts:162`（每帧 setDisplayedContent）。

---

## File Structure

- Create: `apps/web/src/hooks/runtime-event-state.test.ts` — characterization test，固定 appendRuntimeEvent/appendRuntimeEvents 现有与新增行为（重构护栏）。
- Create: `apps/web/src/hooks/runtime-event-state.bench.ts` — 基准脚本，量化连续 append 的耗时（优化前后对比）。
- Modify: `apps/web/src/hooks/runtime-event-state.ts` — 抽出 `compareRuntimeEvents`、新增 `isTailOrdered` 短路、新增 `appendRuntimeEvents` 批量函数。
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts` — RUNTIME_EVENT 分支用 rAF 批量合并 runtimeEvents 的 setState。
- Create: `packages/ui/src/hooks/useSmoothStream.test.ts` — `shouldFlush` 纯函数单测（bun:test，不依赖 React 测试库）。
- Modify: `packages/ui/src/hooks/useSmoothStream.ts` — setState 与 rAF 解耦，按 flush 间隔限流。

---

## Task 1：为 runtime-event-state 建立 characterization test 与基准

**Files:**
- Create: `apps/web/src/hooks/runtime-event-state.test.ts`
- Create: `apps/web/src/hooks/runtime-event-state.bench.ts`

- [ ] **Step 1: 写 characterization test（先固定现有行为）**

Create `apps/web/src/hooks/runtime-event-state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { LumeRuntimeEvent } from '@lume/shared'
import { appendRuntimeEvent, appendRuntimeEvents } from './runtime-event-state'

type EventSeed = Partial<LumeRuntimeEvent> & {
  type: LumeRuntimeEvent['type']
  id: string
  threadId: string
  createdAt: string
}

function makeEvent(seed: EventSeed): LumeRuntimeEvent {
  return { sequence: 0, ...seed } as LumeRuntimeEvent
}

function delta(id: string, seq: number, text: string, createdAt: string): LumeRuntimeEvent {
  return makeEvent({
    type: 'assistant.delta', id, threadId: 't1', createdAt, sequence: seq,
    runId: 'run-1', messageId: 'msg-1', delta: text,
  })
}

function userSubmit(id: string, text: string, createdAt: string): LumeRuntimeEvent {
  return makeEvent({ type: 'message.user.submitted', id, threadId: 't1', createdAt, text })
}

describe('appendRuntimeEvent', () => {
  test('连续同 owner 的 assistant.delta 被合并为一条', () => {
    let state = {}
    state = appendRuntimeEvent(state, delta('d1', 1, '你好', '2026-06-21T00:00:00.001Z'))
    state = appendRuntimeEvent(state, delta('d2', 2, '世界', '2026-06-21T00:00:00.002Z'))
    expect(state.t1.events).toHaveLength(1)
    expect((state.t1.events[0] as any).delta).toBe('你好世界')
  })

  test('按 createdAt 排序（乱序到达时正确还原顺序）', () => {
    let state = {}
    state = appendRuntimeEvent(state, delta('d2', 2, 'B', '2026-06-21T00:00:00.002Z'))
    state = appendRuntimeEvent(state, delta('d1', 1, 'A', '2026-06-21T00:00:00.001Z'))
    expect((state.t1.events[0] as any).delta).toBe('AB')
  })

  test('run.completed 设置 terminalStatus=completed', () => {
    let state = {}
    state = appendRuntimeEvent(state, delta('d1', 1, 'x', '2026-06-21T00:00:00.001Z'))
    state = appendRuntimeEvent(state, makeEvent({
      type: 'run.completed', id: 'r1', threadId: 't1', createdAt: '2026-06-21T00:00:00.010Z',
    }))
    expect(state.t1.terminalStatus).toBe('completed')
  })

  test('超过 MAX_EVENTS_PER_THREAD(100) 时裁剪到尾部并保留最近一条 user 提交', () => {
    let state = {}
    state = appendRuntimeEvent(state, userSubmit('u0', 'hi', '2026-06-21T00:00:00.000Z'))
    for (let i = 1; i <= 120; i++) {
      state = appendRuntimeEvent(state, delta(`d${i}`, i, `${i}`, `2026-06-21T00:00:0${String(Math.floor(i / 10)).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`))
    }
    expect(state.t1.events.length).toBeLessThanOrEqual(100)
  })
})

describe('appendRuntimeEvents (批量)', () => {
  test('批量追加的结果与逐个追加一致', () => {
    const batch = [
      delta('d1', 1, 'A', '2026-06-21T00:00:00.001Z'),
      delta('d2', 2, 'B', '2026-06-21T00:00:00.002Z'),
      delta('d3', 3, 'C', '2026-06-21T00:00:00.003Z'),
    ]
    const batched = appendRuntimeEvents({}, batch)
    let sequential = {}
    for (const e of batch) sequential = appendRuntimeEvent(sequential, e)
    expect((batched.t1.events[0] as any).delta).toBe('ABC')
    expect(batched.t1.events.length).toBe(sequential.t1.events.length)
    expect(batched.t1.terminalStatus).toBe(sequential.t1.terminalStatus)
  })
})
```

> 注：`appendRuntimeEvents` 尚不存在，相关用例此时应失败（TDD 红灯）。其余为 characterization（固定现有行为）。

- [ ] **Step 2: 运行 test 确认现状**

Run: `bun test apps/web/src/hooks/runtime-event-state.test.ts`
Expected: `appendRuntimeEvent` 相关用例 PASS；`appendRuntimeEvents (批量)` 用例 FAIL（`appendRuntimeEvents is not a function`）。

- [ ] **Step 3: 写基准脚本**

Create `apps/web/src/hooks/runtime-event-state.bench.ts`:

```ts
import { appendRuntimeEvent } from './runtime-event-state'
import type { LumeRuntimeEvent } from '@lume/shared'

function delta(seq: number, text: string): LumeRuntimeEvent {
  return {
    type: 'assistant.delta', id: `d${seq}`, threadId: 't1',
    createdAt: `2026-06-21T00:00:00.${String(seq).padStart(3, '0')}Z`,
    sequence: seq, runId: 'run-1', messageId: 'msg-1', delta: text,
  } as LumeRuntimeEvent
}

const N = 1000
let state: any = {}
const start = performance.now()
for (let i = 1; i <= N; i++) state = appendRuntimeEvent(state, delta(i, `t${i}`))
const elapsed = performance.now() - start
console.log(`appendRuntimeEvent x${N}: ${elapsed.toFixed(1)}ms, final events=${state.t1.events.length}`)
```

- [ ] **Step 4: 运行基准记录基线**

Run: `bun apps/web/src/hooks/runtime-event-state.bench.ts`
Expected: 打印一行耗时（记为 **基线 B0**，例如 `appendRuntimeEvent x1000: XXXms`）。后续 Task 2 完成后对比。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/runtime-event-state.test.ts apps/web/src/hooks/runtime-event-state.bench.ts
git commit -m "test(web): 为 runtime-event-state 增加 characterization test 与基准"
```

---

## Task 2：appendRuntimeEvent 增量 sort 优化（去无条件全量排序）

**Files:**
- Modify: `apps/web/src/hooks/runtime-event-state.ts`（抽出 `compareRuntimeEvents`、新增 `isTailOrdered`、append 路径短路）

- [ ] **Step 1: 抽出 compareRuntimeEvents（纯重构，test 保持绿）**

In `apps/web/src/hooks/runtime-event-state.ts`，把 `sortRuntimeEvents` 的比较逻辑抽成独立函数（现有第 72-83 行）：

```ts
function compareRuntimeEvents(a: LumeRuntimeEvent, b: LumeRuntimeEvent): number {
  const timeOrder = a.createdAt.localeCompare(b.createdAt)
  if (timeOrder !== 0) return timeOrder
  const semanticOrder = runtimeEventOrder(a) - runtimeEventOrder(b)
  if (semanticOrder !== 0) return semanticOrder
  if (typeof a.sequence === 'number' && typeof b.sequence === 'number') {
    return a.sequence - b.sequence
  }
  return 0
}

function sortRuntimeEvents(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  return [...events].sort(compareRuntimeEvents)
}
```

- [ ] **Step 2: 运行 test 确认重构无回归**

Run: `bun test apps/web/src/hooks/runtime-event-state.test.ts`
Expected: 除 `appendRuntimeEvents` 批量用例外全部 PASS（行为不变）。

- [ ] **Step 3: 加 isTailOrdered 短路（性能优化）**

在 `runtime-event-state.ts` 顶部工具区新增，并在 `appendRuntimeEvent` 改用短路：

```ts
/** 追加/合并后，若尾部仍保持全局有序则无需全量排序（流式 delta 几乎总是命中）。 */
function isTailOrdered(events: LumeRuntimeEvent[]): boolean {
  if (events.length < 2) return true
  const n = events.length
  return compareRuntimeEvents(events[n - 2], events[n - 1]) <= 0
}

function orderedAppend(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const merged = appendOrMergeRuntimeEvent(events, event)
  return isTailOrdered(merged) ? merged : sortRuntimeEvents(merged)
}
```

然后修改 `appendRuntimeEvent`（现有第 21 行）：

```ts
// 旧：const events = trimRuntimeEvents(sortRuntimeEvents(appendOrMergeRuntimeEvent(current?.events ?? [], event)))
const events = trimRuntimeEvents(orderedAppend(current?.events ?? [], event))
```

- [ ] **Step 4: 运行 test 确认正确性不变 + 重跑基准对比提速**

Run: `bun test apps/web/src/hooks/runtime-event-state.test.ts`
Expected: 全部 PASS（除待 Task 3 的批量用例）。

Run: `bun apps/web/src/hooks/runtime-event-state.bench.ts`
Expected: 耗时显著低于基线 B0（有序短路使 1000 次 append 不再每次全量 sort）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/runtime-event-state.ts
git commit -m "⚡️ perf(web): appendRuntimeEvent 有序尾部短路，避免每 token 全量 sort"
```

---

## Task 3：appendRuntimeEvents 批量函数 + listener rAF 合并

**Files:**
- Modify: `apps/web/src/hooks/runtime-event-state.ts`（新增 `appendRuntimeEvents`）
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts:79-82`（RUNTIME_EVENT 用 rAF 批量）

- [ ] **Step 1: 实现 appendRuntimeEvents（让 Task 1 的批量 test 转绿）**

在 `runtime-event-state.ts` 新增（紧邻 `appendRuntimeEvent` 之后）：

```ts
export function appendRuntimeEvents(
  prev: RuntimeEventState,
  events: LumeRuntimeEvent[],
): RuntimeEventState {
  if (events.length === 0) return prev
  let next = prev
  // 按线程分组，每组复用 orderedAppend（尾部短路），最后仅对该组做一次 trim
  const byThread = new Map<string, LumeRuntimeEvent[]>()
  for (const event of events) {
    const list = byThread.get(event.threadId) ?? []
    list.push(event)
    byThread.set(event.threadId, list)
  }
  for (const [threadId, list] of byThread) {
    const current = next[threadId]
    let acc = current?.events ?? []
    for (const event of list) {
      acc = orderedAppend(acc, event)
    }
    const trimmed = trimRuntimeEvents(acc)
    const terminal = list.reduce<ThreadRuntimeEventState['terminalStatus'] | undefined>(
      (status, event) => getTerminalStatus(event) ?? status,
      current?.terminalStatus,
    )
    next = {
      ...next,
      [threadId]: { events: trimmed, terminalStatus: terminal, updatedAt: Date.now() },
    }
  }
  return next
}
```

- [ ] **Step 2: 运行 test 确认批量用例转绿**

Run: `bun test apps/web/src/hooks/runtime-event-state.test.ts`
Expected: 全部 PASS（含 `appendRuntimeEvents (批量)`）。

- [ ] **Step 3: listener 引入 rAF 批量合并**

Modify `apps/web/src/hooks/useGlobalAgentListeners.ts`。先在文件顶部 import 区新增：

```ts
import { appendRuntimeEvent, appendRuntimeEvents } from './runtime-event-state'
```

在 hook 内（`useGlobalAgentListeners` 函数体，紧邻各 `useSetAtom` 之后）新增批量缓冲：

```ts
  const pendingRuntimeEventsRef = useRef<LumeRuntimeEvent[]>([])
  const runtimeEventsRafRef = useRef<number | null>(null)
  const flushRuntimeEvents = useCallback(() => {
    runtimeEventsRafRef.current = null
    const batch = pendingRuntimeEventsRef.current
    if (batch.length === 0) return
    pendingRuntimeEventsRef.current = []
    setRuntimeEvents((prev) => appendRuntimeEvents(prev, batch))
  }, [setRuntimeEvents])
  const enqueueRuntimeEvent = useCallback((event: LumeRuntimeEvent) => {
    pendingRuntimeEventsRef.current.push(event)
    if (runtimeEventsRafRef.current === null) {
      runtimeEventsRafRef.current = requestAnimationFrame(flushRuntimeEvents)
    }
  }, [flushRuntimeEvents])
```

> 当前第 1 行仅 `import { useEffect } from 'react'`，需改为 `import { useCallback, useEffect, useRef } from 'react'`。`LumeRuntimeEvent` 当前未 import，需在第 17-30 行的 `@lume/shared` type import 块中新增 `type LumeRuntimeEvent`。

然后在 `case AGENT_IPC_CHANNELS.RUNTIME_EVENT:` 分支（现有第 82 行）：

```ts
// 旧：setRuntimeEvents((prev) => appendRuntimeEvent(prev, event))
enqueueRuntimeEvent(event)
```

在 hook 末尾 `useEffect` 的 cleanup（现有第 253 行附近）补充取消未触发的 rAF：

```ts
    return () => {
      unlisten.then((fn) => fn())
      if (runtimeEventsRafRef.current !== null) {
        cancelAnimationFrame(runtimeEventsRafRef.current)
        runtimeEventsRafRef.current = null
      }
    }
```

> 派生状态（`setStreamingStates` / `setSidePanelViews` / pending interactive 等）保持即时调用不变——它们是轻量对象赋值，且即时反映"正在输入"指示更好；runtimeEvents 的投影才是主成本，已通过批量降低。

- [ ] **Step 4: typecheck + 确认现有 listener 测试无回归**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

Run: `bun test apps/web/src/components/welcome/WelcomeView.test.tsx`
Expected: PASS（确认 listener 行为对现有用例无回归）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/runtime-event-state.ts apps/web/src/hooks/useGlobalAgentListeners.ts
git commit -m "⚡️ perf(web): 用 rAF 批量合并流式 runtimeEvents 的 setState"
```

---

## Task 4：useSmoothStream 把 setState 与 rAF 解耦（限流 XMarkdown 重解析）

**Files:**
- Create: `packages/ui/src/hooks/useSmoothStream.test.ts` — `shouldFlush` 纯函数单测（bun:test，不依赖 React 测试库）
- Modify: `packages/ui/src/hooks/useSmoothStream.ts` — 抽出并导出 `shouldFlush` 纯函数，renderLoop 调用它限流 setState

- [ ] **Step 1: 写 shouldFlush 纯函数测试（失败：函数尚未导出）**

Create `packages/ui/src/hooks/useSmoothStream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { shouldFlush } from './useSmoothStream'

describe('shouldFlush', () => {
  const base = { lastFlushTime: 0, flushInterval: 50 }

  test('距上次 flush 不足间隔且队列非空 → 不 flush', () => {
    expect(shouldFlush({ ...base, currentTime: 30, queueLength: 10, streamDone: false })).toBe(false)
  })

  test('达到 flush 间隔 → flush', () => {
    expect(shouldFlush({ ...base, currentTime: 50, queueLength: 5, streamDone: false })).toBe(true)
  })

  test('流结束且队列已空 → 即使未到间隔也 flush（保证最终内容落盘）', () => {
    expect(shouldFlush({ ...base, currentTime: 1, queueLength: 0, streamDone: true })).toBe(true)
  })

  test('流结束但队列还有内容 → 不立即 flush（让 renderLoop 继续消费）', () => {
    expect(shouldFlush({ ...base, currentTime: 1, queueLength: 3, streamDone: true })).toBe(false)
  })
})
```

> 设计说明：把"是否该触发 setState"抽成纯函数，可在不依赖任何 React 测试库的情况下用 bun:test 直接断言。`packages/ui` 目前未安装 `@testing-library/react`，纯函数方案避免引入新依赖。

- [ ] **Step 2: 运行 test 确认失败（红灯）**

Run: `bun test packages/ui/src/hooks/useSmoothStream.test.ts`
Expected: FAIL（`shouldFlush is not a function` 或 import 报错——函数尚未导出）。

- [ ] **Step 3: 导出 shouldFlush 纯函数 + renderLoop 调用它限流 setState**

Modify `packages/ui/src/hooks/useSmoothStream.ts`。先在文件顶部（`segmentText` 函数之后、`useSmoothStream` 之前）导出纯函数：

```ts
/** 决定本帧是否触发 React setState（驱动 Markdown 重解析）。rAF 每帧累积字符到 ref，仅在达到间隔或流结束时才 setState。 */
export function shouldFlush(input: {
  currentTime: number
  lastFlushTime: number
  flushInterval: number
  queueLength: number
  streamDone: boolean
}): boolean {
  return (
    input.currentTime - input.lastFlushTime >= input.flushInterval
    || (input.queueLength === 0 && input.streamDone)
  )
}
```

在 `UseSmoothStreamOptions` 增加可选参数：

```ts
interface UseSmoothStreamOptions {
  content: string
  isStreaming: boolean
  minDelay?: number
  /** 驱动 React setState（进而触发 Markdown 重解析）的最小间隔（ms），默认 50 */
  flushInterval?: number
}
```

在 hook 内 refs 区新增（现有第 89 行附近）：

```ts
  const lastFlushTimeRef = useRef(0)
```

修改签名接收 `flushInterval = 50`：

```ts
export function useSmoothStream({
  content,
  isStreaming,
  minDelay = 10,
  flushInterval = 50,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
```

修改 `renderLoop`（现有第 135-171 行）——rAF 每帧累积字符到 `displayedRef`，但 `setDisplayedContent` 改由 `shouldFlush` 决定：

```ts
  const renderLoop = useCallback((currentTime: number) => {
    const queue = chunkQueueRef.current

    if (queue.length === 0) {
      if (streamDoneRef.current) {
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    if (currentTime - lastRenderTimeRef.current < minDelay) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }
    lastRenderTimeRef.current = currentTime

    let count = Math.max(1, Math.floor(queue.length / 5))
    const chars = queue.splice(0, count)
    displayedRef.current += chars.join('')

    // setState 限流：仅在达到 flush 间隔或流结束时触发，减少 XMarkdown 重解析
    if (shouldFlush({ currentTime, lastFlushTime: lastFlushTimeRef.current, flushInterval, queueLength: queue.length, streamDone: streamDoneRef.current })) {
      lastFlushTimeRef.current = currentTime
      setDisplayedContent(displayedRef.current)
    }

    if (queue.length > 0 || !streamDoneRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
    } else {
      rafRef.current = null
    }
  }, [minDelay, flushInterval])
```

- [ ] **Step 4: 运行 test + typecheck**

Run: `bun test packages/ui/src/hooks/useSmoothStream.test.ts`
Expected: PASS（shouldFlush 四个用例全部通过）。

Run: `bun run --filter @lume/ui typecheck`
Expected: 通过。

- [ ] **Step 5: 手动验证流式体感 + Commit**

手动验证（可选但推荐）：启动 `bun run dev`，发一条会产出长 Markdown + 代码块的回复，观察输出期间掉帧是否明显改善、打字机效果是否仍平滑。

```bash
git add packages/ui/src/hooks/useSmoothStream.ts packages/ui/src/hooks/useSmoothStream.test.ts
git commit -m "⚡️ perf(ui): useSmoothStream 限流 setState，减少流式 Markdown 重解析"
```

---

## 集成验收（Phase 1 完成后）

- [ ] 全量回归：`bun test apps/web packages/ui` 全绿。
- [ ] 基准对比：重跑 `bun apps/web/src/hooks/runtime-event-state.bench.ts`，确认耗时显著低于基线 B0。
- [ ] 手动体感：长流式输出（多代码块）期间 DevTools Performance 录制，主线程单帧 < 16ms，无长任务。

## 注意事项与边界

- **批量延迟一帧的语义**：runtimeEvents 的 setState 延迟 ≤ 1 帧（~16ms），用户无感；派生状态（streaming 指示）保持即时。
- **flushInterval 默认 50ms**：打字机仍平滑（rAF 持续累积），仅 React 重渲染降到 ~20fps。若体感偏慢，下调至 33。
- **不动投影与 stabilize**：增量投影、memo 去 `JSON.stringify`、订阅粒度拆分属于 Phase 2（需更大重构），本 Phase 不触碰，避免范围蔓延。
