import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from '@lume/shared'

export interface ThreadRuntimeEventState {
  events: LumeRuntimeEvent[]
  terminalStatus?: 'completed' | 'failed' | 'cancelled'
  updatedAt: number
}

export type RuntimeEventState = Record<string, ThreadRuntimeEventState>

// 每线程保留的 runtime events 上限。runtimeEvents 当前同时承担「流式事件流」
// 与历史渲染源两个角色：上限过小会 trim 掉早期 turn，导致长对话历史消息消失
// （AgentMessages 投影优先用 runtimeEvents）。2000 覆盖绝大多数对话；彻底解耦
// 需让历史来自持久化消息源（待后续重构）。
const MAX_EVENTS_PER_THREAD = 2000

export function appendRuntimeEvent(
  prev: RuntimeEventState,
  event: LumeRuntimeEvent,
): RuntimeEventState {
  const current = prev[event.threadId]
  const resolution = resolveSubmittedUserEvent(current?.events ?? [], event)
  if (resolution.action === 'skip') return prev
  const base = current?.events ?? []
  const events = trimRuntimeEvents(resolution.action === 'replace'
    ? sortRuntimeEvents(base.map((existing, index) => index === resolution.index ? event : existing))
    : orderedAppend(base, event))
  return {
    ...prev,
    [event.threadId]: {
      events,
      terminalStatus: getTerminalStatus(event) ?? current?.terminalStatus,
      updatedAt: Date.now(),
    },
  }
}

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
      const resolution = resolveSubmittedUserEvent(acc, event)
      if (resolution.action === 'skip') continue
      if (resolution.action === 'replace') {
        acc = sortRuntimeEvents(acc.map((existing, index) => index === resolution.index ? event : existing))
        continue
      }
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

// hydrate 入口短路指纹：persisted 投影是 append-only + 确定性 id（run 级拼接），
// 指纹相同即 persisted 未变 ⇒ 上次 merge 已吸收进 current ⇒ 产物与 current 相同。
// 避免每条 MESSAGE_APPENDED 重复走 merge（O(n log n)）+ 逐位比较。假阳性只会
// 丢一次更新且下次指纹变化自愈——指纹命中的前提是 length/首尾 id 全同。
const persistedHydrateFingerprints = new Map<string, string>()

function persistedFingerprint(events: LumeRuntimeEvent[]): string {
  return `${events.length}:${events[0]?.id ?? ''}:${events[events.length - 1]?.id ?? ''}`
}

/** 重置 hydrate 指纹（测试隔离用：模块级 Map 在同模块测试间共享）。 */
export function resetHydrateFingerprints(): void {
  persistedHydrateFingerprints.clear()
}

export function hydrateRuntimeEvents(
  prev: RuntimeEventState,
  result: AgentThreadRuntimeEventsResult,
): RuntimeEventState {
  const current = prev[result.threadId]
  if (result.events.length === 0) {
    return prev
  }
  const fingerprint = persistedFingerprint(result.events)
  if (persistedHydrateFingerprints.get(result.threadId) === fingerprint) {
    return prev
  }
  // 与 append 路径同上限：sidecar 回放不封顶，hydrate 不 trim 会让重开的超长线程
  // 全量驻留内存（且直到下一条 append 前都无界）。merge 阶段已按 live 规则合并相邻
  // 同流 delta（回放无 assistant.final，正文全靠 delta，先合并再 trim 才不会误伤）。
  const events = trimRuntimeEvents(mergeHydratedRuntimeEvents(result.events, current?.events ?? []))
  persistedHydrateFingerprints.set(result.threadId, fingerprint)
  if (current && sameRuntimeEvents(current.events, events)) {
    return prev
  }
  return {
    ...prev,
    [result.threadId]: {
      events,
      terminalStatus: events.reduce<ThreadRuntimeEventState['terminalStatus']>(
        (status, event) => getTerminalStatus(event) ?? status,
        current?.terminalStatus,
      ),
      updatedAt: Date.now(),
    },
  }
}

/** 删除线程的 runtime events 条目（回收站/永久删除时调用，防止 Record 只增不减）。 */
export function removeRuntimeEvents(
  prev: RuntimeEventState,
  threadId: string,
): RuntimeEventState {
  persistedHydrateFingerprints.delete(threadId)
  if (!(threadId in prev)) return prev
  const next = { ...prev }
  delete next[threadId]
  return next
}

function mergeHydratedRuntimeEvents(
  persistedEvents: LumeRuntimeEvent[],
  liveEvents: LumeRuntimeEvent[],
): LumeRuntimeEvent[] {
  const merged: LumeRuntimeEvent[] = []
  const seenIds = new Set<string>()
  for (const event of [...persistedEvents, ...liveEvents]) {
    if (seenIds.has(event.id)) continue
    const resolution = resolveSubmittedUserEvent(merged, event)
    if (resolution.action === 'skip') continue
    if (resolution.action === 'replace') merged[resolution.index] = event
    else merged.push(event)
    seenIds.add(event.id)
  }
  // 回放按内容块/流事件逐条产出 delta，不像 live 路径边流边合并，计数远更膨胀——
  // 直接 trim 会把头部 turn 的正文 delta 丢掉（回放没有 assistant.final 兜底重建，
  // 投影 text 完全靠 delta 累积，丢了就是空泡）。先按 live 同规则合并相邻同流 delta，
  // 让上限语义两条路径一致。
  return mergeAdjacentStreamDeltas(sortRuntimeEvents(merged))
}

function mergeAdjacentStreamDeltas(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  const merged: LumeRuntimeEvent[] = []
  for (const event of events) {
    const last = merged[merged.length - 1]
    if (
      last !== undefined
      && (last.type === 'assistant.delta' || last.type === 'assistant.thinking_delta')
      && (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta')
      && last.type === event.type
      && hasSameAssistantStreamOwner(last, event)
    ) {
      merged[merged.length - 1] = { ...last, delta: last.delta + event.delta }
      continue
    }
    merged.push(event)
  }
  return merged
}

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

/** 追加/合并后，若尾部仍保持全局有序则无需全量排序（流式 delta 几乎总是命中）。 */
function isTailOrdered(events: LumeRuntimeEvent[]): boolean {
  if (events.length < 2) return true
  const n = events.length
  return compareRuntimeEvents(events[n - 2], events[n - 1]) <= 0
}

/** 合并新事件后，尾部有序则短路返回，否则回退全量 sort；行为等价于 sortRuntimeEvents(appendOrMergeRuntimeEvent(...))。 */
function orderedAppend(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const merged = appendOrMergeRuntimeEvent(events, event)
  return isTailOrdered(merged) ? merged : sortRuntimeEvents(merged)
}

function sameRuntimeEvents(a: LumeRuntimeEvent[], b: LumeRuntimeEvent[]): boolean {
  return a.length === b.length && a.every((event, index) => sameRuntimeEvent(event, b[index]))
}

function sameRuntimeEvent(a: LumeRuntimeEvent, b: LumeRuntimeEvent | undefined): boolean {
  if (a === b) return true
  if (!b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function isOptimisticSubmission(event: LumeRuntimeEvent): boolean {
  return event.id.startsWith('optimistic:') || event.runId.startsWith('optimistic:')
}

type SubmittedUserResolution =
  | { action: 'skip' }
  | { action: 'replace'; index: number }
  | { action: 'append' }

/**
 * message.user.submitted 去重三态判定(#414)：text+30s 窗口只服务「乐观双写副本 ↔
 * 权威事件」配对——同侧相遇（双乐观/双权威）即使同文本同窗口也是两次独立提交，
 * 不得互杀（30 秒内重发同文本的第二条气泡曾被整体吞掉）。权威者胜：新事件为权威
 * 时替换乐观副本（继承槽位，携带真实 runId/messageId）；新事件为乐观时跳过（权威
 * 已在）。messageId 精确相等仍无条件 skip（IM 渠道 raw/model-expanded 双写）。
 */
function resolveSubmittedUserEvent(
  events: LumeRuntimeEvent[],
  next: LumeRuntimeEvent,
): SubmittedUserResolution {
  if (next.type !== 'message.user.submitted') return { action: 'append' }
  const nextOptimistic = isOptimisticSubmission(next)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'message.user.submitted' || event.threadId !== next.threadId) continue
    if (event.messageId && next.messageId && event.messageId === next.messageId) return { action: 'skip' }
    if (
      event.text === next.text
      && Math.abs(Date.parse(event.createdAt) - Date.parse(next.createdAt)) < 30_000
      && isOptimisticSubmission(event) !== nextOptimistic
    ) {
      return nextOptimistic ? { action: 'skip' } : { action: 'replace', index }
    }
  }
  return { action: 'append' }
}

function runtimeEventOrder(event: LumeRuntimeEvent): number {
  if (event.type === 'run.started') return 0
  if (event.type === 'message.user.submitted') return 1
  if (event.type === 'assistant.thinking_delta') return 2
  if (event.type === 'assistant.delta') return 2
  if (event.type === 'assistant.final') return 3
  if (event.type === 'tool.started') return 4
  if (event.type === 'tool.completed') return 5
  if (event.type === 'tool.failed') return 5
  if (event.type === 'tool.permission_timeout') return 5
  if (event.type === 'plan.preview') return 6
  if (event.type === 'im.delivery') return 7
  if (event.type === 'memory.context.used') return 8
  if (event.type === 'task.progress') return 9
  if (event.type.startsWith('context.compaction.')) return 10
  if (event.type === 'usage.updated') return 10
  if (event.type.startsWith('run.')) return 11
  return 9
}

function appendOrMergeRuntimeEvent(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const last = events.at(-1)
  if (last?.type === 'assistant.delta' && event.type === 'assistant.delta' && hasSameAssistantStreamOwner(last, event)) {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  if (
    last?.type === 'assistant.thinking_delta'
    && event.type === 'assistant.thinking_delta'
    && hasSameAssistantStreamOwner(last, event)
  ) {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  // tool.output 快照按稳定 id 原地替换(适配器对同一 toolCallId 恒发同 id):
  // 事件数组每运行中 bash 恒占 1 条，2000 上限零压力；task_progress 等事件
  // 可能插队，所以不能只看尾部，按 id 全表定位（数组 ≤2000，~7 次/秒可忽略）。
  if (event.type === 'tool.output') {
    const index = events.findIndex((existing) => existing.id === event.id)
    if (index >= 0) {
      const next = [...events]
      next[index] = event
      return next
    }
  }
  return [...events, event]
}

function hasSameAssistantStreamOwner(a: LumeRuntimeEvent, b: LumeRuntimeEvent): boolean {
  return a.runId === b.runId
    && a.parentToolUseId === b.parentToolUseId
    && a.subagentRunId === b.subagentRunId
    && getAssistantMessageId(a) === getAssistantMessageId(b)
}

function getAssistantMessageId(event: LumeRuntimeEvent): string | undefined {
  if (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta') {
    return event.messageId
  }
  return undefined
}

function trimRuntimeEvents(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  if (events.length <= MAX_EVENTS_PER_THREAD) return events

  // 超限时优先从头部丢弃可重建的 assistant.delta / thinking_delta——它们对应的
  // 历史 turn 已有 assistant.final 提供完整内容（投影时 final 会重建文本），丢了
  // 不伤历史；而结构事件（user/tool/run/plan/todo/compaction）一旦丢失就是整段
  // 历史消失。尾部（含当前 streaming）的 delta 是流式内容唯一来源，头部丢弃波及不到。
  const overflow = events.length - MAX_EVENTS_PER_THREAD
  let dropped = 0
  const withoutDelta = events.filter((event) => {
    if (dropped >= overflow) return true
    if (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta') {
      dropped += 1
      return false
    }
    return true
  })
  if (withoutDelta.length <= MAX_EVENTS_PER_THREAD) return withoutDelta

  // 结构事件本身超限：取尾部 MAX + rescue 最近一条 user submit（保留会话起点锚点）
  const tail = withoutDelta.slice(-MAX_EVENTS_PER_THREAD)
  if (tail.some((event) => event.type === 'message.user.submitted')) {
    return tail
  }
  const latestUserBeforeTail = [...withoutDelta.slice(0, -MAX_EVENTS_PER_THREAD)]
    .reverse()
    .find((event) => event.type === 'message.user.submitted')
  return latestUserBeforeTail ? [latestUserBeforeTail, ...tail.slice(1)] : tail
}

function getTerminalStatus(event: LumeRuntimeEvent): ThreadRuntimeEventState['terminalStatus'] | undefined {
  if (event.type === 'run.completed') return 'completed'
  if (event.type === 'run.turn_limited') return 'completed'
  if (event.type === 'run.failed') return 'failed'
  if (event.type === 'run.cancelled') return 'cancelled'
  return undefined
}
