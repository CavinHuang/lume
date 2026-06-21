# Phase 2b：AgentMessages 增量 projection（消除全量 replay）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 2 的第二个子 plan。Phase 2 拆为 2a（已完成，抽 `applyRuntimeEvent` reducer 奠基）/ 2b（本 plan，增量集成 + 引用稳定）/ 2c（去 stringify + 订阅粒度）。

**Goal:** 把 AgentMessages 的 `projectedMessages` 从「每帧全量 `projectRuntimeEventMessages(runtimeEvents)`（O(事件数)）」改为「增量 apply」——`useRef` 持有跨帧 `ProjectionState` + 已处理事件引用，每帧只对新追加事件 `applyRuntimeEvent`（O(新事件数)，通常 O(1)）；version 切换 / compact 截断 / 线程切换等非追加场景自动 fallback 全量重投影。未变消息由此获得天然引用稳定。

**Architecture:**
- `runtime-event-message-projection.ts`：导出 2a 已实现的 `applyRuntimeEvent` / `ProjectionState`（当前模块内未 export）；新增 `snapshotAssistant`（从 `flushAssistant` 抽出「只构建视图消息、不 push」的纯函数，`flushAssistant` 改为复用它）、`buildMessagesView`（`state.messages` + `currentAssistant` 快照，不 mutate state——增量 state 跨帧保持，不能每帧 push 否则累积重复）、`applyRuntimeEventsIncremental(events, prev)` + `canApplyIncrementally` 守卫 + `ProjectionRef` / `IncrementalProjectionResult` 类型。
- `AgentMessages.tsx`：`projectedMessages` 的 `useMemo` 改用 `useRef<ProjectionRef | null>` + `applyRuntimeEventsIncremental(runtimeEvents, ref.current)`。
- **不改**：`agent-message-state.ts`（stabilize/reconcile）、`RuntimeEventContentBlock.tsx`（memo）、`agent-atoms.ts`（订阅粒度）——那是 2c。

**Tech Stack:** React 18 + TypeScript + bun:test。无新依赖。

**审查依据:** `AgentMessages.tsx:62-66`（projectedMessages 全量 useMemo）、`runtime-event-message-projection.ts`（2a 的 `applyRuntimeEvent` / `keepLatestVersionTurns` / `projectRuntimeEventMessages` / `flushAssistant`）、`agent-message-state.ts:339-378`（stabilize stringify）、`RuntimeEventContentBlock.tsx:45-55`（memo `prev.message === next.message` 命中点）、Phase 1 `appendRuntimeEvents`（追加语义：旧事件元素引用被复用，是增量检测的前提）。

**诚实的收益边界（重要）:**
- ✅ **消除全量 replay**：长对话（N 事件）每帧投影从 O(N) 降到 O(新事件数)。流式追加场景新事件数通常 1–几，接近 O(1)。
- ✅ **未变消息引用稳定**：增量 `applyRuntimeEvent` 不 touch 已 flush 进 `state.messages` 的历史消息 → 它们的对象引用跨帧不变 → memo 的 `prev.message === next.message`（RuntimeEventContentBlock.tsx:52）直接命中，跳过该消息的 memo `JSON.stringify`（:54）。
- ⚠️ **stabilize 的 stringify 仍在**（agent-message-state.ts:348 message 级 / :370 block 级）：2b 让 stabilize cache 命中率提高（引用稳定 → 内容相同 → 复用旧引用），但 `JSON.stringify` 调用本身未消除。**移除 stabilize stringify 是 2c**。本 plan 不动 stabilize。
- ⚠️ **reconcile 的 spread**（agent-message-state.ts:97）：匹配到 visible 消息时 `{...message}` 创建新对象，破坏引用。但流式期间 assistant content 每 token 变，通常不匹配 visible（历史持久化的最终 content）→ 引用保持。命中匹配的边界情况由 stabilize 兜底（2c 优化）。
- ⚠️ **version turn 增量**：`keepLatestVersionTurns` 是全局 2-pass 预处理，增量处理「新 version 使旧 version turn 失效」很复杂。本 plan 用保守 fallback：新事件含 `versionGroupId` 的 `message.user.submitted` → fallback 全量重投影（`canApplyIncrementally` 守卫）。普通流式（delta/tool/usage）不触发，走增量。

---

## File Structure

- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts` — 导出 `applyRuntimeEvent`/`ProjectionState`；`flushAssistant` 重构复用 `snapshotAssistant`；新增 `buildMessagesView` / `applyRuntimeEventsIncremental` / `canApplyIncrementally` + `ProjectionRef` / `IncrementalProjectionResult` 类型。`projectRuntimeEventMessages` 保持不变（全量，作为 fallback 与等价性基准）。
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.test.ts` — 追加「增量 == 全量」等价性 test + 引用稳定 test。
- Modify: `apps/web/src/components/agent/AgentMessages.tsx:62-66` — `projectedMessages` 改增量。
- 不改：`agent-message-state.ts`、`RuntimeEventContentBlock.tsx`、`agent-atoms.ts`、`AgentMessages.tsx` 其余部分。

---

## Task 1：等价性 + 引用稳定 test 先行（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.test.ts`

先写 test 锁定行为。`applyRuntimeEventsIncremental` 尚未实现，这些 test 初始 fail（或编译错）——这是 TDD 红灯。Task 2 实现后转绿。

- [ ] **Step 1: 读 test 文件的 `event` helper + 现有结构**

读 `runtime-event-message-projection.test.ts` 顶部，确认 `event(...)` helper 的签名（如何构造各类 LumeRuntimeEvent）与现有 import 风格。新增 test 复用该 helper。

- [ ] **Step 2: 新增 incrementalProject helper + 等价性 test 用例**

在文件末尾（最后一个 `test(...)` 之后、`describe` 块内或新增 describe）追加：

```ts
import { applyRuntimeEventsIncremental, type ProjectionRef } from './runtime-event-message-projection'

/** 模拟「事件逐个追加」的增量调用，返回最终 messages（用于与全量对比）。 */
function incrementalProject(events: LumeRuntimeEvent[]): RuntimeMessageView[] {
  let ref: ProjectionRef | null = null
  let messages: RuntimeMessageView[] = []
  for (let i = 1; i <= events.length; i++) {
    const result = applyRuntimeEventsIncremental(events.slice(0, i), ref)
    ref = result.ref
    messages = result.messages
  }
  return messages
}

describe('applyRuntimeEventsIncremental 与全量投影等价', () => {
  test('纯 assistant.delta 追加：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'u1' }),
      event({ type: 'run.started', runId: 'r1' }),
      event({ type: 'assistant.delta', runId: 'r1', delta: 'Hello' }),
      event({ type: 'assistant.delta', runId: 'r1', delta: ' world' }),
      event({ type: 'run.completed', runId: 'r1', finalMessageId: 'a1' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('tool 调用序列：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'run tool', messageId: 'u2' }),
      event({ type: 'run.started', runId: 'r2' }),
      event({ type: 'tool.started', runId: 'r2', toolCallId: 't1', toolName: 'Read', createdAt: '2026-05-11T00:00:01.000Z' }),
      event({ type: 'assistant.delta', runId: 'r2', delta: 'reading' }),
      event({ type: 'tool.completed', runId: 'r2', toolCallId: 't1', toolName: 'Read', createdAt: '2026-05-11T00:00:02.000Z', resultPreview: 'ok' }),
      event({ type: 'run.completed', runId: 'r2', finalMessageId: 'a2' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('多轮对话（多 user/assistant turn）：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'q1', messageId: 'u3' }),
      event({ type: 'run.started', runId: 'r3' }),
      event({ type: 'assistant.delta', runId: 'r3', delta: 'a1' }),
      event({ type: 'run.completed', runId: 'r3', finalMessageId: 'a3' }),
      event({ type: 'message.user.submitted', text: 'q2', messageId: 'u4' }),
      event({ type: 'run.started', runId: 'r4' }),
      event({ type: 'assistant.delta', runId: 'r4', delta: 'a2' }),
      event({ type: 'run.completed', runId: 'r4', finalMessageId: 'a4' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('usage.updated / im.delivery 等辅助事件：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'u5' }),
      event({ type: 'run.started', runId: 'r5' }),
      event({ type: 'assistant.delta', runId: 'r5', delta: 'x' }),
      usageEvent(5),  // 复用现有 usageEvent helper（构造完整 usage.updated）
      event({ type: 'run.completed', runId: 'r5', finalMessageId: 'a5' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('version turn 切换（触发 fallback）：增量结果 == 全量', () => {
    // 两组同 versionGroupId 的 user.submitted，versionIndex 递增 → keepLatestVersionTurns 只保留高 version
    const events = [
      event({ type: 'message.user.submitted', text: 'v1', messageId: 'u-v1', versionGroupId: 'vg1', versionIndex: 0, versionCount: 2 } as any),
      event({ type: 'run.started', runId: 'r-v1' }),
      event({ type: 'assistant.delta', runId: 'r-v1', delta: 'old' }),
      event({ type: 'run.completed', runId: 'r-v1', finalMessageId: 'a-v1' }),
      event({ type: 'message.user.submitted', text: 'v2', messageId: 'u-v2', versionGroupId: 'vg1', versionIndex: 1, versionCount: 2 } as any),
      event({ type: 'run.started', runId: 'r-v2' }),
      event({ type: 'assistant.delta', runId: 'r-v2', delta: 'new' }),
      event({ type: 'run.completed', runId: 'r-v2', finalMessageId: 'a-v2' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('compact 截断（事件回退）：增量结果 == 全量', () => {
    // 先增量投 5 事件，再用前 2 事件重投（模拟 compact 后 events 缩短）→ fallback
    const full = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u6' }),
      event({ type: 'run.started', runId: 'r6' }),
      event({ type: 'assistant.delta', runId: 'r6', delta: 'a' }),
      event({ type: 'assistant.delta', runId: 'r6', delta: 'b' }),
      event({ type: 'run.completed', runId: 'r6', finalMessageId: 'a6' }),
    ]
    let ref: ProjectionRef | null = null
    let messages: RuntimeMessageView[] = []
    for (let i = 1; i <= full.length; i++) {
      const result = applyRuntimeEventsIncremental(full.slice(0, i), ref)
      ref = result.ref
      messages = result.messages
    }
    // compact：events 缩短为前 2 个
    const afterCompact = applyRuntimeEventsIncremental(full.slice(0, 2), ref)
    expect(afterCompact.messages).toEqual(projectRuntimeEventMessages(full.slice(0, 2)))
  })
})

describe('applyRuntimeEventsIncremental 引用稳定', () => {
  test('纯追加：未变历史消息引用跨帧不变', () => {
    const base = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u7' }),
      event({ type: 'run.started', runId: 'r7' }),
      event({ type: 'assistant.delta', runId: 'r7', delta: 'first' }),
      event({ type: 'run.completed', runId: 'r7', finalMessageId: 'a7' }),
    ]
    const r1 = applyRuntimeEventsIncremental(base, null)
    // 第一帧：user 消息（index 0）引用
    const userMsgRef = r1.messages[0]

    // 追加新 turn
    const extended = [
      ...base,
      event({ type: 'message.user.submitted', text: 'q2', messageId: 'u8' }),
      event({ type: 'run.started', runId: 'r8' }),
      event({ type: 'assistant.delta', runId: 'r8', delta: 'second' }),
    ]
    const r2 = applyRuntimeEventsIncremental(extended, r1.ref)
    // 历史首条 user 消息引用不变（增量未 touch）
    expect(r2.messages[0]).toBe(userMsgRef)
    // 且内容仍正确
    expect(r2.messages[0]).toMatchObject({ id: 'u7', type: 'user' })
  })

  test('同一流式 assistant 的 text block 引用稳定（增量 mutate 不重建历史 block）', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u9' }),
      event({ type: 'run.started', runId: 'r9' }),
      event({ type: 'assistant.delta', runId: 'r9', delta: 'Hello' }),
    ]
    const r1 = applyRuntimeEventsIncremental(events, null)
    const r2 = applyRuntimeEventsIncremental(
      [...events, event({ type: 'assistant.delta', runId: 'r9', delta: ' world' })],
      r1.ref,
    )
    // 流式 assistant 消息每帧是新快照（currentAssistant 快照），但其内 text block 引用应稳定
    const assistant1 = r1.messages.at(-1)!
    const assistant2 = r2.messages.at(-1)!
    expect(assistant1.type).toBe('assistant')
    expect(assistant2.type).toBe('assistant')
    // 第一个 text block 引用稳定（appendAssistantTextBlock mutate 同一 block）
    if (assistant1.type === 'assistant' && assistant2.type === 'assistant') {
      const textBlock1 = assistant1.blocks.find((b) => b.type === 'text')!
      const textBlock2 = assistant2.blocks.find((b) => b.type === 'text')!
      expect(textBlock2).toBe(textBlock1)
      expect((textBlock2 as any).text).toBe('Hello world')
    }
  })
})
```

> **用例说明**：
> - 等价性用例（5 个）：覆盖纯 delta / tool / 多轮 / 辅助事件 / version fallback / compact fallback。`incrementalProject` 模拟逐事件追加（最严格地压测增量路径）。每条断言 `incrementalProject(events)` deep-equal `projectRuntimeEventMessages(events)`——若增量实现正确（增量路径 + fallback 路径都等价于全量），全绿。
> - 引用稳定用例（2 个）：历史消息引用跨帧不变（`toBe` 引用相等）；流式 assistant 的 text block 引用稳定（mutate 而非重建）。
> - `event` helper 的字段（versionGroupId/usage 等）若与上面假设不符，调整以匹配实际 helper。`as any` 用于 usage/version 等helper 未直接覆盖的字段。
> - 这 7 个 test 初始因 `applyRuntimeEventsIncremental` 未实现而 fail（TS 编译错或运行时 undefined）——预期，Task 2 实现后转绿。

- [ ] **Step 3: 运行确认 test 失败（红灯）**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: 编译错误（`applyRuntimeEventsIncremental` / `ProjectionRef` 未导出）或新增 7 个 test fail。记录基线（当前 18 pass / 1 fail 不变，新 test 全 fail）。

> 这是 TDD 红灯。不要为了让它过而临时实现——Task 2 正式实现。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent/runtime-event-message-projection.test.ts
git commit -m "test(web): projection 增量投影等价性与引用稳定 test（TDD 红灯）"
```

---

## Task 2：projection.ts 增量实现（snapshotAssistant + buildMessagesView + applyRuntimeEventsIncremental）

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`

- [ ] **Step 1: 导出 applyRuntimeEvent + ProjectionState**

2a 已实现 `ProjectionState` interface 与 `applyRuntimeEvent` 函数（模块内，未 export）。给两者加 `export`：

```ts
export interface ProjectionState {
  messages: RuntimeMessageView[]
  currentAssistant: MutableAssistantMessage | null
  terminalClosed: boolean
}

export function applyRuntimeEvent(state: ProjectionState, event: LumeRuntimeEvent): void {
  // ...2a 已有实现，不变，仅加 export...
}
```

> 仅在 `interface ProjectionState` 和 `function applyRuntimeEvent` 前加 `export` 关键字。实现体零改动。

- [ ] **Step 2: 抽 snapshotAssistant，flushAssistant 复用它**

当前 `flushAssistant`（约 line 522-546）既「判断是否渲染」又「push 到 messages」。抽出一个纯函数 `snapshotAssistant` 只构建视图消息（不 push），`flushAssistant` 改为复用它 push：

```ts
/** 构建当前 assistant 的视图消息（不 mutate state.messages）。无内容且非 streaming 占位时返回 null。 */
function snapshotAssistant(assistant: MutableAssistantMessage | null): RuntimeMessageView | null {
  if (!assistant) return null
  const hasContent = assistantHasContent(assistant)
  const shouldRenderPlaceholder = assistant.status === 'streaming'
  if (!hasContent && !shouldRenderPlaceholder) return null
  return {
    id: assistant.id,
    type: 'assistant',
    text: assistant.text,
    thinking: assistant.thinking,
    ...(assistant.messageId ? { messageId: assistant.messageId } : {}),
    ...(assistant.completedAt ? { completedAt: assistant.completedAt } : {}),
    blocks: assistant.blocks,
    status: assistant.status,
    ...(assistant.error ? { error: assistant.error } : {}),
    ...(assistant.imDelivery ? { imDelivery: assistant.imDelivery } : {}),
    tokenCount: assistant.providerTokenCount ?? estimateAssistantTokenCount(assistant),
    ...(assistant.providerTokenCount !== undefined ? { tokenCountSource: 'provider' as const } : {}),
    ...(assistant.providerTokenUsage ? { tokenUsage: assistant.providerTokenUsage } : {}),
    toolCalls: [...assistant.toolCalls.values()],
  }
}

function flushAssistant(
  messages: RuntimeMessageView[],
  assistant: MutableAssistantMessage | null,
): void {
  const snapshot = snapshotAssistant(assistant)
  if (snapshot) messages.push(snapshot)
}
```

> `snapshotAssistant` 的返回对象与原 `flushAssistant` 的 push 对象**逐字段一致**（从原实现搬运，不改任何字段）。`flushAssistant` 现在是 `snapshotAssistant` + push 的薄封装。这保证全量路径行为不变（706 test + 18/1 基线保持）。

- [ ] **Step 3: 新增 buildMessagesView（增量视图构建，不 mutate state）**

在 `flushAssistant` 之后新增：

```ts
/**
 * 构建投影的最终消息视图：历史已 flush 消息 + 当前 currentAssistant 快照。
 * 关键：不 mutate state.messages——增量场景 state 跨帧保持，每帧只在「视图」末尾附上
 * currentAssistant 快照，不能 push（否则跨帧累积重复 assistant）。
 * 全量 projectRuntimeEventMessages 末尾的 flushAssistant 等价于此处的快照追加。
 */
function buildMessagesView(state: ProjectionState): RuntimeMessageView[] {
  const snapshot = snapshotAssistant(state.currentAssistant)
  return snapshot ? [...state.messages, snapshot] : [...state.messages]
}
```

> 等价性核心：全量 `projectRuntimeEventMessages` 从 `[]` 跑全部事件（过程中 `flushAssistant` push 已完成的），末尾 `flushAssistant` push 最后的 currentAssistant。增量 `state.messages` 累积「过程中 flush 的」（与全量相同事件序列 → 相同 push），`currentAssistant` 是最后未 flush 的；`buildMessagesView` = `state.messages` + currentAssistant 快照。两者 deep-equal。

- [ ] **Step 4: 新增类型 + canApplyIncrementally + applyRuntimeEventsIncremental**

在 `projectRuntimeEventMessages` 之后（或 `applyRuntimeEvent` 之后）新增：

```ts
export interface ProjectionRef {
  state: ProjectionState
  events: LumeRuntimeEvent[]
}

export interface IncrementalProjectionResult {
  messages: RuntimeMessageView[]
  ref: ProjectionRef
}

/**
 * 判断能否对 events 做增量 apply（相对 prev）。
 * 增量条件（全部满足）：
 * 1. 有 prev（非首次）；
 * 2. events.length >= prev.events.length（未截断——compact/回退则 fallback）；
 * 3. 若 prev 非空，events 的「最后一条旧事件」引用 === prev 的对应引用（追加语义：旧事件元素引用被复用。换线程/version 重写会改变引用 → fallback）；
 * 4. 新追加的事件中不含带 versionGroupId 的 message.user.submitted（version turn 重组需 keepLatestVersionTurns 全局重算 → 保守 fallback）。
 */
function canApplyIncrementally(events: LumeRuntimeEvent[], prev: ProjectionRef): boolean {
  if (events.length < prev.events.length) return false
  if (events.length === 0) return true
  const lastOldIndex = prev.events.length - 1
  if (lastOldIndex >= 0 && events[lastOldIndex] !== prev.events[lastOldIndex]) return false
  for (let i = prev.events.length; i < events.length; i++) {
    const event = events[i]
    if (event?.type === 'message.user.submitted' && (event as any).versionGroupId) return false
  }
  return true
}

/**
 * 增量投影：能增量则只 apply 新事件到 prev.state；否则 fallback 全量重投影。
 * 返回最终消息视图 + 供下一帧增量判断的 ref（ref.events 始终是原始 events，便于下次引用比较）。
 */
export function applyRuntimeEventsIncremental(
  events: LumeRuntimeEvent[],
  prev: ProjectionRef | null,
): IncrementalProjectionResult {
  if (prev && canApplyIncrementally(events, prev)) {
    const state = prev.state
    for (let i = prev.events.length; i < events.length; i++) {
      applyRuntimeEvent(state, events[i]!)
    }
    return { messages: buildMessagesView(state), ref: { state, events } }
  }
  // fallback：全量重投影
  const state: ProjectionState = { messages: [], currentAssistant: null, terminalClosed: false }
  const kept = keepLatestVersionTurns(events)
  for (const event of kept) {
    applyRuntimeEvent(state, event)
  }
  return { messages: buildMessagesView(state), ref: { state, events } }
}
```

> **关键点**：
> - 增量路径：`canApplyIncrementally` 已保证无 version turn，故新事件无需过 `keepLatestVersionTurns`（它对无 version 事件是 no-op，返回原数组）。直接 `applyRuntimeEvent` 每条新事件到 prev.state。
> - fallback 路径：与 `projectRuntimeEventMessages` 完全一致（`keepLatestVersionTurns` → 全量 apply → `buildMessagesView`）。
> - `ref.events` 恒为原始 `events`（非 `kept`）：下次增量检测比较的是 `runtimeEvents[i] === prev.events[i]`（原始引用），`kept` 是过滤后的新数组引用不同，不能用。
> - `buildMessagesView` 不 mutate state：增量 state 跨帧复用，`currentAssistant` 的快照只在视图末尾，不进 `state.messages`。当后续 `run.completed`/`message.user.submitted` 事件触发 `applyRuntimeEvent` 内的 `flushAssistant` 时，才把完成的 assistant push 进 `state.messages` 持久化。

- [ ] **Step 5: projectRuntimeEventMessages 复用 buildMessagesView（可选简化，保持等价）**

当前 `projectRuntimeEventMessages`（2a 重构后）末尾是 `flushAssistant(state.messages, state.currentAssistant); return state.messages`。可改为 `return buildMessagesView(state)`（语义等价：buildMessagesView = state.messages + currentAssistant 快照；而原 flushAssistant 把快照 push 后返回 state.messages，结果相同）。**但为降低风险**，保留原 `flushAssistant + return state.messages` 不动（它与 buildMessagesView 等价，但已通过 706 test 验证，不动更安全）。本 step 标注为「可选」，默认**不改** `projectRuntimeEventMessages`。

> 若选择不改：`projectRuntimeEventMessages` 与 `applyRuntimeEventsIncremental` fallback 路径在「currentAssistant 快照」上有细微实现差异（前者 push 到 state.messages 后返回；后者 buildMessagesView 返回 [...state.messages, snapshot] 不 push）。两者返回值 deep-equal（Task 1 等价性 test 验证），但 state.messages 内容不同（前者含最后 assistant，后者不含）。**这不影响正确性**——fallback 后 state 被 ref 持有，下一帧若增量，applyRuntimeEvent 会继续在「不含最后 assistant」的 state.messages 上工作，与全量从 [] 重跑一致（因为 fallback 已重置 state）。Task 1 的 compact test 覆盖此场景。

- [ ] **Step 6: 运行 test 确认等价性 + 引用稳定全绿**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: **原 18 pass / 1 fail 基线保持 + 新增 7 个 test 全绿**（5 等价 + 2 引用稳定）。即 25 pass / 1 fail（同一个 compaction timeline 既有失败不变）。

> 若等价性 test 有 fail：对照全量结果与增量结果 diff，检查 `canApplyIncrementally` 守卫是否误判（把该 fallback 的当成增量，或反之）、`buildMessagesView` 快照是否漏字段。引用稳定 test fail：检查增量是否意外重建了历史消息（state.messages 应复用旧引用）。

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/agent/runtime-event-message-projection.ts
git commit -m "⚡️ perf(web): projection 增量 applyRuntimeEventsIncremental，消除每帧全量 replay"
```

---

## Task 3：AgentMessages 集成（projectedMessages 改增量）

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`

- [ ] **Step 1: import applyRuntimeEventsIncremental + ProjectionRef**

`AgentMessages.tsx:14` 现有 `import { projectRuntimeEventMessages } from './runtime-event-message-projection'`。改为：

```ts
import {
  applyRuntimeEventsIncremental,
  projectRuntimeEventMessages,
  projectVisibleThreadMessages,
  type ProjectionRef,
} from './runtime-event-message-projection'
```

> 确认 `projectVisibleThreadMessages` 是否已从该文件 import（现有 line 65 用了它）。若已 import 则不重复；调整 import 块合并。

- [ ] **Step 2: 新增 projectionRef，projectedMessages 改增量**

在组件内现有 ref 声明区（约 line 55-59 附近，`stabilizeCacheRef` 等附近）新增：

```ts
const projectionRef = useRef<ProjectionRef | null>(null)
```

替换 `projectedMessages` 的 `useMemo`（当前 line 62-66）：

```ts
const projectedMessages = useMemo(() => {
  if (runtimeEvents.length > 0) {
    const result = applyRuntimeEventsIncremental(runtimeEvents, projectionRef.current)
    projectionRef.current = result.ref
    return result.messages
  }
  // runtimeEvents 为空（如纯历史会话，无 runtime events）：走 visibleThreadMessages 投影
  projectionRef.current = null
  return projectVisibleThreadMessages(visibleThreadMessages)
}, [runtimeEvents, visibleThreadMessages])
```

> **关键**：
> - `runtimeEvents.length > 0` 走增量；空时走 `projectVisibleThreadMessages`（与原逻辑一致），并清空 `projectionRef`（下次有 runtime events 时从全量开始）。
> - `projectionRef.current = result.ref`：把本次的 ref 存下，下次 useMemo 重算时作 prev。`applyRuntimeEventsIncremental` 内部决定增量或 fallback。
> - **线程切换**：`runtimeEvents` 来自 `agentRuntimeEventsAtom[threadId]`，threadId 变 → runtimeEvents 是完全不同的数组（不同 threadId 的事件）→ `canApplyIncrementally` 的「最后旧事件引用相同」检查失败 → 自动 fallback 全量重投影。✓ 无需额外处理。
> - **compact**：compact 后 runtimeEvents 可能缩短（用 compaction summary 替换历史）→ `events.length < prev.events.length` → fallback。✓

- [ ] **Step 3: 运行 AgentMessages test**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: 全绿（该 test 覆盖 stabilizeRuntimeMessages / reconcileUserMessageVersions 等纯函数，不直接测组件 render 的增量，但确认 import 与类型无误）。

> 若 AgentMessages.test.ts 有渲染相关 test 失败，检查 `projectedMessages` 改动是否破坏了 render 契约（应不破坏——返回值类型与结构不变，仍是 `RuntimeMessageView[]`）。

- [ ] **Step 4: typecheck + projection test 回归**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: 25 pass / 1 fail（基线 + 新增 7 全绿）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentMessages.tsx
git commit -m "⚡️ perf(web): AgentMessages projectedMessages 改增量投影，引用稳定"
```

---

## Task 4：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: agent 目录回归 + 隔离对比**

Run: `bun test apps/web/src/components/agent/ 2>&1 | tail -5`
Expected: 与 Phase 2a 完成时的基线一致（Phase 2a 记录：23 fail / 18 errors，全为 pre-existing 的 desktop-api `saveFilePathDialog` 等问题，与本 plan 无关）。**关键**：projection 相关 test（runtime-event-message-projection + AgentMessages）应全绿（除 pre-existing compaction timeline 1 fail）。

若不确定某 fail 是否本 plan 引起，隔离对比：
```bash
# 记录当前（新）fail 数
bun test apps/web/src/components/agent/ 2>&1 | tail -3
# 临时回退 projection.ts + AgentMessages.tsx
git stash  # 若有未提交（本 plan 已 commit，工作区应干净，跳过 stash）
git checkout HEAD~3 -- apps/web/src/components/agent/runtime-event-message-projection.ts apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/AgentMessages.tsx
bun test apps/web/src/components/agent/ 2>&1 | tail -3  # 旧实现
git checkout HEAD -- apps/web/src/components/agent/runtime-event-message-projection.ts apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/AgentMessages.tsx  # 恢复
```
对比新旧 fail 数。新不应多于旧（除新增的 7 个 projection test 全 pass）。

> 注意：`git checkout HEAD~3` 的层数需对应本 plan 的 3 个 commit（Task 1 test + Task 2 projection + Task 3 AgentMessages）。实施时按实际 commit 数调整（`git log --oneline -5` 确认）。

- [ ] **Step 2: typecheck 全量**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 3: 引用稳定人工验证（可选但推荐）**

在 AgentMessages 渲染处（RuntimeEventContentBlock 的 memo 比较 RuntimeEventContentBlock.tsx:45-55）加临时 `console.log` 或用 React DevTools Profiler：流式输出期间，历史消息（非最后一条）不应 re-render（memo `prev.message === next.message` 命中）。验证后移除临时日志。

> 这是 2b 的核心收益验证：增量投影让历史消息引用稳定 → memo 浅比较命中 → 跳过 re-render。2c 会进一步移除 stabilize/memo 的 stringify。

- [ ] **Step 4: 调用方契约检查**

确认 `projectedMessages` 返回值结构与用法不变：
- `liveMessages = stabilizeRuntimeMessages(reconcileUserMessageVersions(projectedMessages, ...), cache)`（AgentMessages.tsx:67-73）：`projectedMessages` 仍是 `RuntimeMessageView[]`，reconcile/stabilize 不变。
- `userVersionRefreshKey`（:80-86）、`latestUserMessageKey`（:87）：消费 projectedMessages，结构不变。

---

## 注意事项与边界

- **纯等价 + 引用稳定**：2b 不改投影语义（增量 == 全量，Task 1 等价性 test 守护），只改计算方式（全量 replay → 增量 apply）。收益是 O(N)→O(新事件) + 历史消息引用稳定。
- **stabilize/memo 的 stringify 不在本 plan**：2b 让引用稳定，stringify 的「命中率」提高（cache 命中、memo 浅比较命中），但 stringify 调用本身仍在。移除是 2c。诚实区分，不过度承诺。
- **fallback 是正确性保障，不是缺陷**：version turn / compact / 线程切换走 fallback 全量重投影，性能与改造前相同（这些场景低频）。常态流式追加走增量（高频，收益所在）。
- **ref.events 用原始 events（非 kept）**：增量检测靠「旧事件元素引用相同」，`keepLatestVersionTurns` 返回过滤新数组引用不同，故 `ProjectionRef.events` 必须存原始 events。增量路径因 `canApplyIncrementally` 已排除 version turn，新事件无需过 keepLatest。
- **buildMessagesView 不 mutate state**：增量 state 跨帧复用，`currentAssistant` 快照只在视图末尾（不 push 到 state.messages），避免跨帧累积重复 assistant。`run.completed`/`message.user.submitted` 事件在 applyRuntimeEvent 内触发 flushAssistant 才把完成的 assistant 持久化进 state.messages。
- **AgentMessages 已有大量 ref + scroll 逻辑**（line 43-129）：本 plan 只加 `projectionRef` 一个 ref + 改 `projectedMessages` useMemo，不动其余。Surgical Changes。
- **不动 keepLatestVersionTurns / MutableAssistantMessage / 各 helper**：只加 export + 新增增量函数 + snapshotAssistant 抽取。
- **706 test（实际 19 test）+ AgentMessages.test**：作为等价护栏。重构后 pass/fail 必须与基线一致（projection: 18/1 → 25/1 含新增 7；AgentMessages.test 全绿）。
