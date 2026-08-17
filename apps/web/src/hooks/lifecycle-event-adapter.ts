import type { Batch1LifecycleDetail, LumeRuntimeEvent, SdkEventEnvelope } from '@lume/shared'
import type { AgentEventBusSource } from './useAgentEventBus'

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

export interface BusEnvelopeConsumerContext {
  /** 模块级(跨挂载实例/跨 tab 切换存活):每线程已投递最大 seq,双实例去重水位。 */
  deliveredSeqByThread: Map<string, number>
  adapterStatesByThread: Map<string, LifecycleAdapterState>
  enqueueRuntimeEvent: (event: LumeRuntimeEvent) => void
  setStreamingStates: (update: (prev: Record<string, 'idle' | 'streaming' | 'errored'>) => Record<string, 'idle' | 'streaming' | 'errored'>) => void
  setErrorMessages: (update: (prev: Record<string, string>) => Record<string, string>) => void
}

/**
 * 总线 envelope 的完整消费副作用(seq 去重 → 适配 → 入队 → streaming 态)。
 *
 * snapshot 来源(重载/切回线程的初始回放)只跑适配器维持求差基线(lastText/
 * turnId),不注入任何事件也不置 streaming:该窗口的内容旧路已覆盖——hydrate
 * (AgentMessages 挂载)与未跳过的旧路 live 推送。若把 snapshot 事件也入队,会与
 * 旧路事件双份注入且 runId 错位(总线 projector 自产 runId)导致投影无法去重
 * (详见 final-fix-report 场景 E:run 终结在 tool 边界时文本持久重复)。
 * 基线必须推进:否则后续 push 的累计 partial 会从空基线全量重发,与旧路已渲染
 * 文本叠加成双份。
 */
export function consumeBusEnvelope(
  envelope: SdkEventEnvelope,
  source: AgentEventBusSource,
  ctx: BusEnvelopeConsumerContext,
): void {
  const threadId = envelope.threadId
  if ((ctx.deliveredSeqByThread.get(threadId) ?? 0) >= envelope.seq) return
  ctx.deliveredSeqByThread.set(threadId, envelope.seq)
  const state = ctx.adapterStatesByThread.get(threadId) ?? createLifecycleAdapterState()
  ctx.adapterStatesByThread.set(threadId, state)
  const events = adaptLifecycleEvent(envelope, state)
  if (source === 'snapshot') return
  for (const event of events) ctx.enqueueRuntimeEvent(event)
  // streaming 态副作用对齐旧 RUNTIME_EVENT 分支(该分支对跳过类型不再置位);
  // 仅 push 置位——快照回放悬空 run(无 run.end)不应把线程永久卡在流式态。
  if (envelope.kind === 'message' && envelope.phase !== 'end') {
    ctx.setStreamingStates((prev) => (
      prev[threadId] === 'streaming' ? prev : { ...prev, [threadId]: 'streaming' }
    ))
  }
  for (const event of events) {
    if (event.type === 'run.completed' || event.type === 'run.turn_limited') {
      ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
    } else if (event.type === 'run.failed') {
      ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: 'errored' }))
      ctx.setErrorMessages((prev) => ({ ...prev, [threadId]: event.error.message }))
    }
  }
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
