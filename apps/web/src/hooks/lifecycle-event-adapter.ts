import type { Batch1LifecycleDetail, LumeRuntimeEvent, SdkEventEnvelope } from '@lume/shared'

/**
 * Batch 1 过渡适配器:生命周期骨架事件 → 等价 RuntimeEvent,喂现有投影组件(UI 零改动)。
 * 批次5 试点链切换完成后整体删除。
 *
 * 映射(取舍见 task-6-report):
 * - message.start → 只重置流式求差基线,不产事件(streaming 态由 update 驱动)
 * - message.update → assistant.delta(text = 累计 partial 与上次差值)
 * - message.end → assistant.final(blocks = detail.message.content 的 text/thinking 块)
 * - turn.* / run.start → 不产事件(turn 落定由 message.end 覆盖;run.started 走旧路)
 * - run.end → max_turns → run.turn_limited;aborted → 不产(旧路 run.cancelled 承担);
 *   isError → run.failed;否则 run.completed
 * - 其他(tool.* 等)→ 忽略
 *
 * 事件 id 由 envelope.seq 派生(线程内唯一且跨重放稳定),便于 hydrate 合并去重。
 */
export interface LifecycleAdapterState {
  /** 当前流式 message 的 turnId(null = 无进行中的 message)。 */
  turnId: string | null
  /** 当前 message 已投递的累计 partial.text(求差基线)。 */
  lastText: string
}

export function createLifecycleAdapterState(): LifecycleAdapterState {
  return { turnId: null, lastText: '' }
}

/** 有状态纯函数:按事件顺序调用,state 由调用方持有(每线程一份)。 */
export function adaptLifecycleEvent(
  envelope: SdkEventEnvelope,
  state: LifecycleAdapterState,
): LumeRuntimeEvent[] {
  const detail = envelope.detail as Batch1LifecycleDetail
  const base = {
    threadId: envelope.threadId,
    runId: envelope.runId,
    createdAt: new Date(envelope.ts).toISOString(),
  }

  if (detail.type === 'message.start') {
    state.turnId = envelope.turnId
    state.lastText = ''
    return []
  }

  if (detail.type === 'message.update') {
    // 防御:update 未 preceded by start 时按新 message 处理,避免拿上一轮基线求差
    if (envelope.turnId !== state.turnId) {
      state.turnId = envelope.turnId
      state.lastText = ''
    }
    const text = detail.partial.text
    const delta = text.startsWith(state.lastText) ? text.slice(state.lastText.length) : ''
    state.lastText = text
    if (!delta) return []
    return [{
      id: `lifecycle:${envelope.seq}:assistant.delta`,
      type: 'assistant.delta' as const,
      ...base,
      delta,
    }]
  }

  if (detail.type === 'message.end') {
    state.turnId = null
    state.lastText = ''
    const blocks = toFinalBlocks(detail.message.content)
    if (blocks.length === 0) return []
    return [{
      id: `lifecycle:${envelope.seq}:assistant.final`,
      type: 'assistant.final' as const,
      ...base,
      blocks,
    }]
  }

  if (detail.type === 'run.end') {
    state.turnId = null
    state.lastText = ''
    const event = adaptRunEnd(envelope, detail, base)
    return event ? [event] : []
  }

  // turn.* / run.start / 未知事件:不产 RuntimeEvent
  return []
}

function adaptRunEnd(
  envelope: SdkEventEnvelope,
  detail: Extract<Batch1LifecycleDetail, { type: 'run.end' }>,
  base: { threadId: string; runId: string; createdAt: string },
): LumeRuntimeEvent | null {
  // 判定来源对齐旧路:sidecar 由 result subtype `error_max_turns` 判 turn_limited
  // (agent-service.ts hasTurnLimitedMarker),且该 subtype 会让 isError 为 true,故先判。
  if (detail.stopReason?.includes('max_turns')) {
    return {
      id: `lifecycle:${envelope.seq}:run.turn_limited`,
      type: 'run.turn_limited',
      ...base,
      reason: detail.stopReason,
    }
  }
  // 中止:软中止流通常无 result 终值(总线不产 run.end),偶发带终值时也让位于
  // 旧路 run.cancelled(未被 flag 跳过),避免同 run 双终态。
  if (detail.stopReason === 'aborted') return null
  if (detail.isError) {
    return {
      id: `lifecycle:${envelope.seq}:run.failed`,
      type: 'run.failed',
      ...base,
      error: { code: 'runtime_error', message: detail.stopReason ?? 'Run failed' },
    }
  }
  return {
    id: `lifecycle:${envelope.seq}:run.completed`,
    type: 'run.completed',
    ...base,
  }
}

/** 与旧路 projectAssistantMessageFinalRuntimeEvent 对齐:只留非空 text/thinking 块。 */
function toFinalBlocks(content: unknown[]): Array<{ type: 'text' | 'thinking'; text: string }> {
  if (!Array.isArray(content)) return []
  const blocks: Array<{ type: 'text' | 'thinking'; text: string }> = []
  for (const block of content) {
    const record = block as Record<string, unknown>
    if (!record || typeof record !== 'object') continue
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      blocks.push({ type: 'text', text: record.text })
    } else if (
      (record.type === 'thinking' || record.type === 'reasoning')
      && typeof record.thinking === 'string'
      && record.thinking.trim()
    ) {
      blocks.push({ type: 'thinking', text: record.thinking })
    }
  }
  return blocks
}
