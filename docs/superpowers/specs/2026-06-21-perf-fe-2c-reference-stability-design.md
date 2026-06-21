# Phase 2c 设计：引用稳定收尾（移除 stabilize/memo 的 JSON.stringify）

> **所属**：性能优化路线图 Phase 2 的第三个子阶段。Phase 2 拆为 2a（抽 `applyRuntimeEvent` reducer）/ 2b（增量 projection + 引用稳定）/ 2c（本 spec：移除 stabilize/memo 的 stringify，兑现引用稳定收益）。atomFamily 订阅粒度拆为 2d，reconcile 算法优化（reduce+Map）拆为 2e。
>
> **前置**：2b 已完成（`applyRuntimeEventsIncremental` + `buildMessagesView`，未变消息引用稳定）。

## 背景与动机

流式渲染热路径每 token 触发：`setRuntimeEvents` → 投影 → stabilize → memo。其中 stabilize 与 memo 各用 `JSON.stringify` 做内容比较：

- `stabilizeRuntimeMessages`（agent-message-state.ts:348）：message 级 `JSON.stringify(message)`
- `stabilizeRuntimeMessageBlocks`（:370）：block 级 `JSON.stringify(prev) === JSON.stringify(block)`
- `areRuntimeEventContentBlockPropsEqual`（RuntimeEventContentBlock.tsx:54）：memo 兜底 `JSON.stringify(prev.message) === JSON.stringify(next.message)`

每条历史消息每帧都要 stringify（O(消息数 × 消息大小)），是流式热路径的主要 CPU 开销之一。

2b 已让「未变历史消息」在 projection 层获得引用稳定（增量 `applyRuntimeEvent` 不 touch 已 flush 进 `state.messages` 的消息 → 对象引用跨帧不变）。**2c 的任务是把 stringify 比较全部替换为引用比较**，让 2b 建立的引用稳定真正兑现为「跳过 stringify、跳过 re-render」。

## Goal

移除 stabilize/memo 链路的全部 `JSON.stringify` 调用，靠引用比较实现等价的「未变消息跳过 re-render」。1000 token 连续输出期间 `JSON.stringify` 调用次数为 0。

## Architecture：数据流

```
projectedMessages        (2b 增量，历史消息引用稳定)
  → reconcileUserMessageVersions   [2c 改动1: +引用稳定 memoize]
  → stabilizeRuntimeMessages       [2c 改动2: 退化为引用比较]
  → liveMessages
  → RuntimeEventContentBlock memo  [2c 改动3: 纯引用比较]
```

核心问题：`reconcileUserMessageVersions` 对「匹配 visible 持久化消息」的输入做 `{...message}` spread（agent-message-state.ts:97-108），**每帧创建新对象、破坏引用**。stabilize 当前的 stringify 正是为了「再稳定」这些被 spread 的消息。因此 stabilize 能否安全退化为引用比较，取决于 reconcile 是否破坏引用 —— **2c 必须先让 reconcile 输出引用稳定**（改动 1），stabilize 才能退化（改动 2）。

匹配行为分析：
- **流式 assistant**：content 每 token 变，不匹配 visible（visible 是历史持久化的最终 content）→ 不 spread → 引用保持（2b）。
- **匹配 visible 的 user 消息**（同 messageId）：每帧被 spread 成新对象（内容不变、引用变）→ 改动 1 的 memoize 解决。

## 改动 1：reconcile 引用稳定化（agent-message-state.ts）

**现状**：`reconcileUserMessageVersions(messages, visibleThreadMessages)` 是纯函数，对匹配 visible 的消息 `{...message}` spread 创建新对象。

**改动**：新增跨帧缓存 `ReconcileCache`，reconcile 匹配/spread 逻辑不变，只在最外层加引用缓存：

```ts
export type ReconcileCache = Map<string, {
  projectedRef: RuntimeMessageView
  visibleRef: AgentMessage | undefined
  result: RuntimeMessageView
}>

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
  cache: ReconcileCache,
): RuntimeMessageView[] {
  // 清理已移除消息的缓存条目（liveIds）
  // 对每条 message：
  //   1. 用现有匹配逻辑找到 visible（不变）
  //   2. cached = cache.get(message.id)
  //   3. if cached && cached.projectedRef === message && cached.visibleRef === visible:
  //        复用 cached.result   ← 引用稳定：projected 引用 + visible 引用都没变
  //   4. else: 执行原 spread 逻辑得 result，cache.set(...)
}
```

**为什么有效**：
- projected message 引用稳定（2b 增量）+ visible 引用稳定（visibleThreadMessages 异步加载后引用固定，直到重新加载）→ 组合稳定 → reconcile 输出引用稳定。
- visible 重新加载时引用变 → `cached.visibleRef === visible` 失败 → 自动 miss 重新 reconcile。✓

**消费方**：AgentMessages 新增 `reconcileCacheRef = useRef<ReconcileCache>(new Map())`，传入 reconcile；thread 切换时清空（与 stabilizeCacheRef 一致，AgentMessages.tsx:289 stabilizeCacheRef.current.clear()）。

## 改动 2：stabilize 退化为引用比较（agent-message-state.ts）

**现状**：message 级（:348）+ block 级（:370）都用 stringify 算签名/比较。

**改动**：两处 stringify 改引用比较，cache 去掉 `signature` 字段：

```ts
export type RuntimeMessageStabilizeCache = Map<string, { message: RuntimeMessageView }>  // 去掉 signature

export function stabilizeRuntimeMessages(messages, cache) {
  // 清理移除消息（不变）
  return messages.map(message => {
    const cached = cache.get(message.id)
    if (cached?.message === message) return cached.message        // 引用相同 → 复用
    const stabilized = stabilizeRuntimeMessageBlocks(message, cached?.message)
    cache.set(message.id, { message: stabilized })
    return stabilized
  })
}

function stabilizeRuntimeMessageBlocks(message, prevMessage) {
  // 类型守卫不变
  const nextBlocks = message.blocks.map(block => {
    const prev = prevById.get(block.id)
    if (prev && prev === block) return prev   // 引用比较代替 JSON.stringify(prev)===JSON.stringify(block)
    return block
  })
  // 复用逻辑不变
}
```

**保留 stabilize 壳的理由**：block 级引用稳定对流式 assistant 仍有价值 —— 流式 assistant message 引用每帧变（buildMessagesView 新快照），但其 blocks 数组引用稳定（2b 让 appendAssistantTextBlock mutate 同一 block），stabilize block 级用引用比较能让未变 block 复用。

## 改动 3：memo 去 stringify 兜底（RuntimeEventContentBlock.tsx:45-55）

**现状**：`areRuntimeEventContentBlockPropsEqual` 有 `prev.message === next.message` 短路（:52，2b 后历史消息已命中）+ stringify 兜底（:54）。

**改动**：移除 stringify 兜底，改为纯引用比较：

```ts
export function areRuntimeEventContentBlockPropsEqual(prev, next) {
  if (prev.streaming !== next.streaming) return false
  if (prev.animate !== next.animate) return false
  if (prev.threadId !== next.threadId) return false
  return prev.message === next.message   // 引用相同 → 跳过 re-render；不同 → re-render
}
```

**安全性**：改动 1（reconcile memoize）+ 改动 2（stabilize 引用）保证历史未变消息引用稳定 → memo 短路命中。引用不同只发生在内容真变时（流式 assistant、projection 真重建）→ re-render 正确。

## 关键不变量

| 消息类型 | reconcile | stabilize | memo | 结果 |
|---|---|---|---|---|
| 历史未变消息 | memoize hit（引用稳定） | 引用 hit | 短路命中 | **跳过 re-render，0 次 stringify** |
| 流式 assistant（最后一条） | 不匹配 visible，原样返回 | block 引用稳定 | message 引用变 → re-render | re-render（正确，内容在变） |
| 匹配 visible 的 user 消息 | memoize hit（引用稳定） | 引用 hit | 短路命中 | 跳过 re-render |

## 测试与验收

**新增 test**（agent-message-state.test.ts 或 RuntimeEventContentBlock 相关 test）：
- reconcile 引用稳定：同一 (projected 引用, visible 引用) 多次调用 → 返回同引用；visible 引用变 → miss 重新 reconcile。
- stabilize 退化：message 引用相同 → 复用 cache；引用变 → block 引用稳定（prev === block 复用）。
- memo 引用比较：`prev.message === next.message` → equal；引用变 → not equal（不再 stringify）。

**回归基线**（零回归护栏）：
- projection test：26 pass / 1 fail（pre-existing compaction 不变）
- AgentMessages test：25 pass / 0 fail
- agent 目录：117 pass / 23 fail / 18 errors（= Phase 2a/2b 基线，全 pre-existing）
- typecheck：exit 0

**验收标准**：1000 token 连续输出期间，stabilize/memo 链路 `JSON.stringify` 调用次数为 0（临时计数插桩或 React DevTools Profiler 验证后移除插桩）。

## 范围边界（YAGNI）

**本 spec 包含**：reconcile 引用稳定 memoize（改动 1，最小改动让 stabilize 可退化）、stabilize 退化（改动 2）、memo 去 stringify（改动 3）。

**本 spec 不包含**：
- atomFamily 订阅粒度（拆 2d）：`agentRuntimeEventsAtom` 全局 Record → atomFamily 按 threadId。
- reconcile 算法优化（拆 2e）：5 次 filter + 嵌套 find → reduce + Map。本 spec 的改动 1 只加引用缓存层，不改匹配算法。
- stabilize 彻底移除：保留壳（block 级引用稳定有价值），只移除 stringify。

## 风险

1. **reconcile memoize cache key 正确性**：key = (projectedRef, visibleRef)。若 visible 引用稳定的假设不成立（如 visibleThreadMessages 每帧新数组但元素引用稳定？），需确认 setState(visibleThreadMessages) 的引用语义。AgentMessages.tsx:230 `setVisibleThreadMessages(messages)` —— messages 是 getThreadMessages 的返回，每次加载新数组，但加载后引用固定直到下次加载。组件内 visibleThreadMessages 引用稳定（useState 不变即不重渲染）。✓
2. **memo 移除 stringify 后的未覆盖边界**：若存在「内容相同但引用变」且未被 reconcile memoize 覆盖的路径 → 偶发 re-render。可接受（远比每帧 stringify 便宜），且 stabilize 引用比较 + reconcile memoize 覆盖主路径。
3. **stabilize 退化不兜底内容**：完全依赖引用稳定。若引用稳定假设被未来改动破坏，memo 会误判 re-render（保守方向，不会「该刷新不刷新」）。
