# Phase 2c：引用稳定收尾（移除 stabilize/memo 的 JSON.stringify）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 2 的第三个子 plan。2a（抽 reducer）/2b（增量 projection + 引用稳定）已完成。本 plan 兑现 2b 引用稳定收益：把 stabilize/memo 的 `JSON.stringify` 比较全部换为引用比较。atomFamily 订阅粒度拆 2d，reconcile 算法优化（reduce+Map）拆 2e。设计依据：`docs/superpowers/specs/2026-06-21-perf-fe-2c-reference-stability-design.md`。

**Goal:** 移除 stabilize/memo 链路的全部 `JSON.stringify` 调用，靠引用比较实现等价的「未变消息跳过 re-render」。1000 token 连续输出期间 stabilize/memo 链路 `JSON.stringify` 调用次数为 0。

**Architecture:** 三步链路改造：(1) `reconcileUserMessageVersions` 加跨帧引用缓存（`ReconcileCache`，可选参数不破坏现有调用）——让匹配 visible 的消息不再每帧 spread 新对象；(2) `stabilizeRuntimeMessages` 退化为引用比较（message 级 + block 级，cache 去掉 signature）；(3) `areRuntimeEventContentBlockPropsEqual` 移除 stringify 兜底，纯靠 `prev.message === next.message`。前提依赖：2b 已让未变历史消息在 projection 层引用稳定，block 引用稳定（`appendAssistantTextBlock` mutate 同一 block）。

**Tech Stack:** React 18 + TypeScript + bun:test。无新依赖。

**审查依据:** `agent-message-state.ts:58-113`（reconcile）、`:339-378`（stabilize，两处 stringify :348/:370）、`RuntimeEventContentBlock.tsx:45-55`（memo，stringify :54）、`AgentMessages.tsx:67-73`（liveMessages 调用 stabilize/reconcile）、`AgentMessages.test.ts:169-361`（reconcile 5 test）、`:510-555`（memo 4 test）、`:557-623`（stabilize 3 test）。

**诚实的收益边界:**
- ✅ **消除 stabilize/memo 的 stringify**：每条历史消息每帧从 `JSON.stringify(message)`（O(消息大小)）降为引用比较（O(1)）。
- ✅ **引用稳定兜底**：reconcile memoize 让匹配 visible 的消息引用稳定；2b 让历史消息 + block 引用稳定。两者覆盖主路径。
- ⚠️ **未覆盖边界偶发 re-render**：若存在「内容相同但引用变」且未被 reconcile memoize 覆盖的路径，memo 会 re-render（不再 stringify 兜底）。可接受（远比每帧 stringify 便宜），且不影响正确性（保守方向，不会「该刷新不刷新」）。
- ⚠️ **atomFamily 订阅粒度不在本 plan**（拆 2d）：线程 A 输出仍可能触发线程 B 组件 re-render（订阅全局 atom）。本 plan 只优化单线程内的 stringify。

---

## File Structure

- Modify: `apps/web/src/components/agent/agent-message-state.ts` — reconcile 加 `ReconcileCache` 类型 + 可选 cache 参数 + 引用缓存层；stabilize `RuntimeMessageStabilizeCache` 去 signature、message/block 级改引用比较。
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx:45-55` — `areRuntimeEventContentBlockPropsEqual` 移除 stringify 兜底。
- Modify: `apps/web/src/components/agent/AgentMessages.tsx` — 新增 `reconcileCacheRef`，传入 reconcile，thread 切换清空。
- Modify: `apps/web/src/components/agent/AgentMessages.test.ts` — stabilize 2 个 test + memo 1 个 test 改引用语义；新增 reconcile 引用稳定 test + stabilize 引用退化 test + memo 引用 test。
- 不改：`runtime-event-message-projection.ts`（2b 已完成）、`agent-atoms.ts`（2d）、reconcile 匹配算法（2e）。

---

## Task 1：reconcile 引用稳定 + AgentMessages 集成

**Files:**
- Modify: `apps/web/src/components/agent/agent-message-state.ts`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/AgentMessages.test.ts`

- [ ] **Step 1: 新增 reconcile 引用稳定 test（TDD 红灯）**

在 `AgentMessages.test.ts` 的 `describe('reconcileUserMessageVersions', ...)` 块内（最后一个 `test(...)` 之后、`})` 闭合之前，即 line 360 `})` 之前）追加。先在文件顶部 import 区加 `ReconcileCache` 类型（line 5-15 的 import 块）：

```ts
import {
  collectNewRuntimeMessageIds,
  getProgrammaticScrollHoldUntil,
  getLatestUserMessageKey,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldApplyThreadMessagesResult,
  shouldAutoScrollAfterUserScroll,
  stabilizeRuntimeMessages,
  type ReconcileCache,
} from './agent-message-state'
```

在 reconcile describe 块末尾追加 test：

```ts
  test('reuses the previous result when projected and visible references are unchanged', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'user:1',
      type: 'user',
      text: 'hello',
      createdAt: '2026-05-01T00:00:00.000Z',
    }]
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()

    const first = reconcileUserMessageVersions(messages, visibleThreadMessages, cache)
    // 第二次：相同的 messages 引用 + 相同 visible 引用 → 复用上次 result（引用稳定）
    const second = reconcileUserMessageVersions(messages, visibleThreadMessages, cache)
    expect(second[0]).toBe(first[0])
  })

  test('re-reconciles when the projected message reference changes', () => {
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()

    const first = reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    // projected 引用变（新对象，内容相同）→ miss → 重新 spread 新 result
    const second = reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    expect(second[0]).not.toBe(first[0])
  })

  test('drops cache entries for removed messages', () => {
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()
    reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    expect(cache.has('user:1')).toBe(true)
    reconcileUserMessageVersions([], visibleThreadMessages, cache)
    expect(cache.has('user:1')).toBe(false)
  })
```

> 现有 5 个 reconcile test（line 203/240/276/324/356 的两参数调用）**不改动** —— Step 3 把 cache 设为可选参数，不传时用临时 map，单次调用行为等价。

- [ ] **Step 2: 运行确认 test 失败（红灯）**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: 编译错误（`ReconcileCache` 未导出 / `reconcileUserMessageVersions` 第三参数类型不匹配）或 3 个新 test fail。原 25 pass 基线暂时受编译错影响（Step 3 实现后恢复）。记录这是 TDD 红灯。

- [ ] **Step 3: 实现 reconcile 引用缓存（agent-message-state.ts）**

把 `reconcileUserMessageVersions`（line 58-113）整段替换为下面版本（匹配/spread 逻辑抽成 `matchVisibleMessage` + `applyReconciledMessage`，外层加 cache）。同时在函数前新增 `ReconcileCache` 类型导出：

```ts
export type ReconcileCache = Map<string, {
  projectedRef: RuntimeMessageView
  visibleRef: AgentMessage | undefined
  result: RuntimeMessageView
}>

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
  cache?: ReconcileCache,
): RuntimeMessageView[] {
  const visibleUsers = visibleThreadMessages.filter((message) => message.role === 'user')
  const visibleAssistants = visibleThreadMessages.filter((message) => message.role === 'assistant')
  if (visibleUsers.length === 0 && visibleAssistants.length === 0) return messages

  const effectiveCache = cache ?? new Map()
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of effectiveCache.keys()) {
    if (!liveIds.has(id)) effectiveCache.delete(id)
  }

  const usedVisibleIds = new Set<string>()
  const usedVisibleAssistantIds = new Set<string>()
  return messages.map((message) => {
    const visible = matchVisibleMessage(message, visibleUsers, visibleAssistants, usedVisibleIds, usedVisibleAssistantIds)
    const cached = effectiveCache.get(message.id)
    if (cached && cached.projectedRef === message && cached.visibleRef === visible) {
      return cached.result
    }
    const result = applyReconciledMessage(message, visible)
    effectiveCache.set(message.id, { projectedRef: message, visibleRef: visible, result })
    return result
  })
}

function matchVisibleMessage(
  message: RuntimeMessageView,
  visibleUsers: AgentMessage[],
  visibleAssistants: AgentMessage[],
  usedVisibleIds: Set<string>,
  usedVisibleAssistantIds: Set<string>,
): AgentMessage | undefined {
  if (message.type === 'user') {
    if (message.messageId) {
      return visibleUsers.find((item) => item.id === message.messageId)
    }
    const visible = visibleUsers.find((item) => (
      !usedVisibleIds.has(item.id)
      && item.content === message.text
      && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
    )) ?? visibleUsers.find((item) => !usedVisibleIds.has(item.id) && item.content === message.text)
    if (visible) usedVisibleIds.add(visible.id)
    return visible
  }
  if (message.type === 'assistant') {
    const visible = visibleAssistants.find((item) => (
      !usedVisibleAssistantIds.has(item.id)
      && item.content === message.text
    ))
    if (visible) usedVisibleAssistantIds.add(visible.id)
    return visible
  }
  return undefined
}

function applyReconciledMessage(
  message: RuntimeMessageView,
  visible: AgentMessage | undefined,
): RuntimeMessageView {
  if (!visible) return message
  if (message.type === 'user') {
    return withPersistedUserMessage(message, visible)
  }
  if (message.type === 'assistant') {
    const providerTokenUsage = readPersistedAssistantTokenUsage(visible.metadata)
    const providerOutputTokens = providerTokenUsage?.outputTokens
    return {
      ...message,
      messageId: visible.id,
      completedAt: new Date(visible.createdAt).toISOString(),
      ...(message.tokenCountSource === 'provider' || providerOutputTokens === undefined
        ? {}
        : {
            tokenCount: providerOutputTokens,
            tokenCountSource: 'provider' as const,
          }),
      ...(message.tokenUsage || providerTokenUsage === undefined ? {} : { tokenUsage: providerTokenUsage }),
    }
  }
  return message
}
```

> **等价性**：`matchVisibleMessage` + `applyReconciledMessage` 逐分支搬运原 map 回调逻辑（user messageId 不推进 used / user fuzzy 推进 / assistant 推进；spread 字段逐一对齐）。cache hit 时 `result === applyReconciledMessage(message, visible)`（相同输入 → 相同输出）→ 与无 cache 等价。现有 5 个 reconcile test（不传 cache）走 `effectiveCache = new Map()`，每条 miss → spread，行为与原版一致。

- [ ] **Step 4: AgentMessages 集成 reconcileCacheRef**

`AgentMessages.tsx`：

4a. import 加 `ReconcileCache` 类型。当前 line 17-29 从 `./agent-message-state` import，把 `type RuntimeMessageStabilizeCache` 附近改为也引入 `ReconcileCache`：

```ts
import {
  collectNewRuntimeMessageIds,
  collectRuntimeMessageIds,
  getLatestUserMessageKey,
  getProgrammaticScrollHoldUntil,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldApplyThreadMessagesResult,
  shouldAutoScrollAfterUserScroll,
  stabilizeRuntimeMessages,
  type ReconcileCache,
  type RuntimeMessageStabilizeCache,
} from './agent-message-state'
```

4b. 新增 ref（紧邻 `stabilizeCacheRef` 声明，约 line 55）：

```ts
const stabilizeCacheRef = useRef<RuntimeMessageStabilizeCache>(new Map())
const reconcileCacheRef = useRef<ReconcileCache>(new Map())
```

4c. `liveMessages` 的 useMemo（当前 line 67-73）传入 `reconcileCacheRef.current`：

```ts
const liveMessages = useMemo(
  () => stabilizeRuntimeMessages(
    reconcileUserMessageVersions(projectedMessages, visibleThreadMessages, reconcileCacheRef.current),
    stabilizeCacheRef.current,
  ),
  [projectedMessages, visibleThreadMessages],
)
```

4d. thread 切换清空 reconcileCache（与 stabilizeCache 一致，当前 line 286-293 的 `useLayoutEffect`）：

```ts
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId
      stabilizeCacheRef.current.clear()
      reconcileCacheRef.current.clear()
      shouldAutoScrollRef.current = true
      latestUserMessageKeyRef.current = latestUserMessageKey
      return scrollMessagesToBottom('instant')
    }
```

- [ ] **Step 5: 运行 test 确认绿 + typecheck**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: **28 pass / 0 fail**（原 25 + 新增 3 reconcile 引用稳定 test）。现有 5 个 reconcile test 不传 cache 仍绿（等价）。

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/agent-message-state.ts apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentMessages.test.ts
git commit -m "⚡️ perf(web): reconcile 引用稳定 memoize（ReconcileCache），为 stabilize 退化奠基"
```

---

## Task 2：stabilize 退化为引用比较

**Files:**
- Modify: `apps/web/src/components/agent/agent-message-state.ts:337-378`
- Modify: `apps/web/src/components/agent/AgentMessages.test.ts:557-623`

- [ ] **Step 1: 更新 stabilize 现有 test + 新增引用退化 test（TDD 红灯）**

stabilize 现有 test 锁定的是 stringify 语义（「内容相同不同对象 → 复用」），2c 退化引用比较后不再成立。改 `AgentMessages.test.ts` 的 `describe('stabilizeRuntimeMessages', ...)`（line 557-623）：

1a. 把 line 558 的 test（"reuses the previous message reference when content is unchanged"）改为引用语义 —— 第二帧传**同引用** msg：

```ts
  test('reuses the previous message reference when message identity is unchanged', () => {
    const cache = new Map()
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'hi',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 't0', text: 'hi' }],
      status: 'streaming',
      tokenCount: 2,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    // 第二帧传同引用 msg（引用未变）→ stabilize 复用
    const second = stabilizeRuntimeMessages([msg], cache)
    expect(second[0]).toBe(first[0])
  })
```

1b. 把 line 576 的 test（"stabilizes unchanged blocks within a changed message"）改为 block 同引用 —— `changed.blocks[0]` 用**同引用** `toolBlock`（不 spread）：

```ts
  test('stabilizes unchanged blocks within a changed message', () => {
    const cache = new Map()
    const toolBlock: RuntimeAssistantBlock = {
      type: 'tool_call',
      id: 'tool:tc1',
      toolCall: { id: 'tc1', toolName: 'Bash', input: {}, status: 'completed' },
    }
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'a',
      thinking: '',
      toolCalls: [],
      blocks: [toolBlock, { type: 'text', id: 't0', text: 'a' }],
      status: 'streaming',
      tokenCount: 1,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    const firstToolBlock = (first[0] as RuntimeAssistantMessageView).blocks[0]
    const changed: RuntimeAssistantMessageView = {
      ...msg,
      text: 'ab',
      tokenCount: 2,
      blocks: [toolBlock, { type: 'text', id: 't0', text: 'ab' }],
    }
    const second = stabilizeRuntimeMessages([changed], cache)
    expect(second[0]).not.toBe(first[0])
    expect((second[0] as RuntimeAssistantMessageView).blocks[0]).toBe(firstToolBlock)
  })
```

1c. line 606 的 test（"drops cache entries for removed messages"）**不改**（与 signature 无关）。

1d. 在 stabilize describe 块末尾（line 622 `})` 之前）新增引用退化 test（验证 stringify 被移除 —— 内容相同但引用不同时**不复用**）：

```ts
  test('does not reuse a message when content matches but identity differs', () => {
    const cache = new Map()
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'hi',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 't0', text: 'hi' }],
      status: 'streaming',
      tokenCount: 2,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    // 内容相同但引用不同（新对象 + 新 block）→ 退化引用比较后不复用
    const rebuilt: RuntimeAssistantMessageView = { ...msg, blocks: [{ type: 'text', id: 't0', text: 'hi' }] }
    const second = stabilizeRuntimeMessages([rebuilt], cache)
    expect(second[0]).not.toBe(first[0])
  })
```

> 1d 的 test 在当前 stringify 实现下会 **FAIL**（stringify 内容相同 → 复用 → `toBe`），这是 TDD 红灯，驱动 Step 2 实现。1a/1b 改后仍绿（同引用下 stringify 也复用），1d 是真正的新行为驱动。

- [ ] **Step 2: 运行确认 1d test 失败（红灯）**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: 新增的 "does not reuse a message when content matches but identity differs" **FAIL**（当前 stringify 复用 → toBe 成立，但期望 not toBe）。其余 stabilize test 绿。记录红灯。

- [ ] **Step 3: 实现 stabilize 退化（agent-message-state.ts）**

3a. `RuntimeMessageStabilizeCache` 类型去 signature（line 337）：

```ts
export type RuntimeMessageStabilizeCache = Map<string, { message: RuntimeMessageView }>
```

3b. `stabilizeRuntimeMessages`（line 339-357）message 级改引用比较：

```ts
export function stabilizeRuntimeMessages(
  messages: RuntimeMessageView[],
  cache: RuntimeMessageStabilizeCache,
): RuntimeMessageView[] {
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) cache.delete(id)
  }
  return messages.map((message) => {
    const cached = cache.get(message.id)
    if (cached?.message === message) return cached.message
    const stabilized = stabilizeRuntimeMessageBlocks(message, cached?.message)
    cache.set(message.id, { message: stabilized })
    return stabilized
  })
}
```

3c. `stabilizeRuntimeMessageBlocks`（line 359-378）block 级改引用比较：

```ts
function stabilizeRuntimeMessageBlocks(
  message: RuntimeMessageView,
  prevMessage: RuntimeMessageView | undefined,
): RuntimeMessageView {
  if (message.type !== 'assistant' || prevMessage?.type !== 'assistant') {
    return message
  }
  const prevById = new Map(prevMessage.blocks.map((block) => [block.id, block]))
  let reusedAny = false
  const nextBlocks = message.blocks.map((block) => {
    const prev = prevById.get(block.id)
    if (prev && prev === block) {
      reusedAny = true
      return prev
    }
    return block
  })
  if (!reusedAny) return { ...message }
  return { ...message, blocks: nextBlocks }
}
```

> 唯一改动：`:348` `JSON.stringify(message)` 签名 → `cached?.message === message` 引用比较；`:370` `JSON.stringify(prev) === JSON.stringify(block)` → `prev === block`。cache value 去 signature 字段。逻辑骨架（清理 + map + block 稳定）不变。

- [ ] **Step 4: 运行 test 确认绿 + projection 回归**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: **29 pass / 0 fail**（Task 1 的 28 + 新增 1d stabilize 退化 test）。原 3 个 stabilize test（改后）+ 1d 全绿。

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: 26 pass / 1 fail（pre-existing compaction 不变 —— stabilize 改动不影响 projection test）。

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/agent-message-state.ts apps/web/src/components/agent/AgentMessages.test.ts
git commit -m "⚡️ perf(web): stabilize 退化为引用比较，移除 message/block 级 JSON.stringify"
```

---

## Task 3：memo 去 stringify 兜底

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx:45-55`
- Modify: `apps/web/src/components/agent/AgentMessages.test.ts:510-555`

- [ ] **Step 1: 更新 memo 现有 test（TDD 红灯）**

memo 现有 test line 521（"treats equal content with a different object identity as equal"）锁定 stringify 兜底（不同对象内容相同 → equal），2c 去 stringify 后变 not equal。改 `AgentMessages.test.ts` 的 `describe('areRuntimeEventContentBlockPropsEqual', ...)`：

把 line 521 的 test 替换为两个 test（引用语义）：

```ts
  test('treats the same message reference as equal', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(true)
  })

  test('treats a different message reference as not equal even when content matches', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = {
      message: { ...baseAssistantMessage, blocks: [{ ...baseAssistantMessage.blocks[0] }] },
      threadId: 't1',
      streaming: false,
      animate: false,
    }
    expect(next.message).not.toBe(prev.message)
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })
```

> "treats a different message reference as not equal even when content matches" 在当前 stringify 实现下 **FAIL**（内容相同 → true，但期望 false）—— TDD 红灯，驱动 Step 2。line 533/544/550（detects text/streaming/animate change）**不改**：它们 prev/next 引用不同 + 内容/标量变 → 2c 后仍 false（引用不同即 false），结果一致。

- [ ] **Step 2: 运行确认新 test 失败（红灯）**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: "treats a different message reference as not equal even when content matches" **FAIL**（当前 stringify 兜底 → true，期望 false）。记录红灯。

- [ ] **Step 3: 实现 memo 去 stringify（RuntimeEventContentBlock.tsx）**

把 `areRuntimeEventContentBlockPropsEqual`（line 45-55）及上方注释改为：

```ts
/**
 * memo 比较函数：靠 message 引用稳定（2b 增量投影 + 2c reconcile/stabilize 引用稳定化）
 * 让未变历史消息跳过 re-render。引用不同即视为变化（re-render）——不再用 JSON.stringify
 * 兜底内容比较（2c 移除）。
 *
 * - 标量 props（streaming/animate/threadId）直接比较；
 * - onOpen* / onUserResizeStart 回调由父级 useCallback 保证引用稳定，不参与比较；
 * - message 用引用比较（===）。
 */
export function areRuntimeEventContentBlockPropsEqual(
  prev: RuntimeEventContentBlockProps,
  next: RuntimeEventContentBlockProps,
): boolean {
  if (prev.streaming !== next.streaming) return false
  if (prev.animate !== next.animate) return false
  if (prev.threadId !== next.threadId) return false
  return prev.message === next.message
}
```

> 移除原 line 53-54（type 比较 + stringify 比较）。`prev.message === next.message` 命中时 return true（跳过 re-render），否则 return false（re-render）。安全性由 Task 1（reconcile memoize）+ Task 2（stabilize 引用）+ 2b（projection 引用稳定）共同保证：历史未变消息引用稳定 → 短路命中。

- [ ] **Step 4: 运行 test 确认绿 + typecheck**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`
Expected: **30 pass / 0 fail**（Task 2 的 29 + memo 净增 1：原 4 test 替换为 5 test，其中 detects text/streaming/animate 3 个 + same reference 1 + different reference 1）。

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/AgentMessages.test.ts
git commit -m "⚡️ perf(web): RuntimeEventContentBlock memo 去 stringify 兜底，纯引用比较"
```

---

## Task 4：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: agent 目录回归**

Run: `bun test apps/web/src/components/agent/ 2>&1 | tail -6`
Expected: **122 pass / 23 fail / 18 errors**（Task 3 后 AgentMessages.test.ts 从 25 → 30，净增 5；117 - 25 + 30 = 122；其余 fail/error 全为 pre-existing 的 desktop-api/overlay 问题，与 Phase 2a/2b 基线一致）。**关键**：projection（26/1）+ AgentMessages（30/0）相关 test 全绿（除 pre-existing compaction 1 fail）。

若 fail 数多于基线，隔离对比：
```bash
git log --oneline -6  # 确认本 plan 的 commit 数
git checkout HEAD~3 -- apps/web/src/components/agent/agent-message-state.ts apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentMessages.test.ts
bun test apps/web/src/components/agent/ 2>&1 | tail -3  # 旧实现基线
git checkout HEAD -- apps/web/src/components/agent/agent-message-state.ts apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentMessages.test.ts  # 恢复
```
对比 fail 数。新不应多于旧。

- [ ] **Step 2: typecheck 全量**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 3: 验收 —— JSON.stringify 调用次数（可选插桩验证）**

在 `agent-message-state.ts` 的 `stabilizeRuntimeMessages` + `stabilizeRuntimeMessageBlocks` + `RuntimeEventContentBlock.tsx` 的 `areRuntimeEventContentBlockPropsEqual` 各加临时计数（模块级 `let stringifyCallCount = 0`，在原 stringify 处确认已无调用）。或用 React DevTools Profiler 观察流式输出期间历史消息是否跳过 re-render。

> 2c 后这三处应**无 `JSON.stringify` 调用**（grep 确认 agent-message-state.ts + RuntimeEventContentBlock.tsx 无 `JSON.stringify`）。验收后移除临时计数代码。

Run（grep 确认无 stringify 残留）:
```bash
grep -n "JSON.stringify" apps/web/src/components/agent/agent-message-state.ts apps/web/src/components/agent/RuntimeEventContentBlock.tsx
```
Expected: 无输出（两文件均无 `JSON.stringify`）。

> 注意：`default-result.tsx` 等其他文件可能有无关的 stringify（路线图 line 275 提及），不在本 plan 范围。只确认 stabilize/memo 链路两文件。

- [ ] **Step 4: 调用方契约检查**

确认 stabilize/memo 改动未破坏消费方：
- `liveMessages`（AgentMessages.tsx:67-73）：`stabilizeRuntimeMessages(reconcileUserMessageVersions(...))` 签名兼容（reconcile 第三参数可选，stabilize 第二参数 cache 不变）。✓
- `RuntimeMessageStabilizeCache` 类型去 signature：AgentMessages.tsx `stabilizeCacheRef = useRef<RuntimeMessageStabilizeCache>(new Map())` 不受影响（只读写 cache，不访问 signature）。✓
- memo `areRuntimeEventContentBlockPropsEqual` 签名不变，RuntimeEventContentBlock 的 `memo(...)` 调用不变。✓

---

## 注意事项与边界

- **语义变更，非纯增量**：2c 把 stabilize/memo 的判定基础从「内容（stringify）」改为「引用」。现有 test 锁定旧语义的部分（stabilize 2 个 + memo 1 个）必须改语义为引用比较 —— 这是 plan 的 Task 1b/2a/3a 步骤，不是「破坏 test」而是「反映新契约」。新增的「内容相同引用不同 → 不复用/not equal」test（1d/3a 第二个）是 2c 新行为的 TDD 红灯驱动。
- **reconcile cache 可选参数**：`cache?: ReconcileCache` 不破坏现有 5 个两参数 test（默认临时 map，单次调用等价）。AgentMessages 显式传 `reconcileCacheRef.current` 获得跨帧引用稳定。
- **stabilize 保留壳**：不彻底移除 stabilize，因为 block 级引用稳定对流式 assistant 仍有价值（流式 message 引用每帧变但 blocks 数组引用稳定）。只移除两处 stringify。
- **fallback 正确性**：reconcile memoize miss（引用变）→ 重新 spread（等价原逻辑）；stabilize miss（引用变）→ 重新 stabilize blocks（block 引用比较）；memo 引用不同 → re-render。均为保守方向（不会「该刷新不刷新」）。
- **不动 projection（2b）/ atomFamily（2d）/ reconcile 算法（2e）**：Surgical Changes。Task 1 的 reconcile 重构只加 cache 层 + 抽 helper，匹配/spread 逻辑逐分支等价搬运（现有 5 test 守护）。
- **706 test（projection 19）+ AgentMessages.test**：作为等价护栏。projection 保持 26/1（Task 2 验证）；AgentMessages.test 从 25 → 30（Task 1-3 逐步增加）。
