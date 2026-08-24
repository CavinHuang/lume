import type {
  FileResultRef,
  MemoryContextUsedRuntimeEvent,
  SdkLifecycleDetail,
  LumeRuntimeEvent,
  SdkEventEnvelope,
  ToolExecutionMetadata,
} from '@lume/shared'
import type { AgentEventBusSource } from './useAgentEventBus'

/**
 * Batch 1 过渡适配器:生命周期骨架事件 → 等价 RuntimeEvent,喂现有投影组件(UI 零改动)。
 * 批次5 试点链切换完成后整体删除。
 *
 * 映射(取舍见 task-6-report;批次5 扩=Phase A 收口):
 * - message.start → 只重置流式求差基线,不产事件(streaming 态由 update 驱动)
 * - message.update → assistant.thinking_delta + assistant.delta(各自 = 累计 partial
 *   与上次差值;thinking 批次5 起总线折叠进 partial.thinking)
 * - message.end → assistant.final(blocks = detail.message.content 的 text/thinking 块)
 * - tool.start → tool.started(inputPreview = detail.input;riskLevel 省略——web 侧无
 *   inferToolMetadata,投影对缺省容忍,徽章不渲染)
 * - tool.end → isError ? tool.failed(error.message = output) : tool.completed
 *   (resultPreview = output);execution/resultRef 批次2.1 补齐——从 detail.meta
 *   (engine _meta)做 web 侧最小归一(校验对齐旧路 normalizeToolExecutionMetadata;
 *   session fileRef 富化为 sidecar 专属,减配留档)
 * - run.start → run.started(批次5 翻转此前"不产"分支;workspaceId/workspaceSlug/model
 *   信封不携带,RunStartedRuntimeEvent 全可选,减配留档)
 * - run.end → max_turns → run.turn_limited;aborted → run.cancelled(批次5 翻转:
 *   projector 已补流中止终值,旧路让位);isError → run.failed;否则 run.completed
 * - memory.context.used → 同名事件(items 引用透传;批次3,数据源在 session 层
 *   而非 SDK 流,由 sidecar lume-runner 第二注入路径直发)
 * - background.task → background.task.completed(批次4,late task_notification 旁路
 *   + projector 主流双入口;streaming 副作用见 consumeBusEnvelope)
 * - todo.state/advisor.reviewed/coding.report → 旧路同形事件(批次5,
 *   sidecar 第二入口双发,载荷同引用;字段对齐 run-item-events 对应构造)
 * - context.compaction 三态 → 同名三事件(批次4;trigger 真值+outcome 已由 projector
 *   透传(加固批次 detail.trigger/detail.outcome,adapter outcome 取 isError 等价),
 *   policy/source/stage 用旧路默认值,preTokens/postTokens 透传,
 *   progress clampProgress 防御复制)
 * - 批次5 裁定不映射:user.message(旧路 message.user.submitted 继续驱动)/
 *   plan.preview(旧路休眠)/task.progress(SDK 后台进度,与旧路 Task 清单事件不同物,
 *   无等价 RuntimeEvent)
 * - 其他未知 detail → 忽略
 *
 * 事件 id 由 envelope.seq 派生(线程内唯一且跨重放稳定),便于 hydrate 合并去重。
 */
export interface LifecycleAdapterState {
  /** 当前流式 message 的 turnId(null = 无进行中的 message)。 */
  turnId: string | null
  /** 当前 message 已投递的累计 partial.text(求差基线)。 */
  lastText: string
  /** 当前 message 已投递的累计 partial.thinking(求差基线,批次5)。 */
  lastThinking: string
}

export function createLifecycleAdapterState(): LifecycleAdapterState {
  return { turnId: null, lastText: '', lastThinking: '' }
}

export interface BusEnvelopeConsumerContext {
  /** 模块级(跨挂载实例/跨 tab 切换存活):每线程已投递最大 seq,双实例去重水位。 */
  deliveredSeqByThread: Map<string, number>
  adapterStatesByThread: Map<string, LifecycleAdapterState>
  enqueueRuntimeEvent: (event: LumeRuntimeEvent) => void
  setStreamingStates: (update: (prev: Record<string, 'idle' | 'streaming' | 'errored'>) => Record<string, 'idle' | 'streaming' | 'errored'>) => void
  setErrorMessages: (update: (prev: Record<string, string>) => Record<string, string>) => void
  /** 批次5:run.cancelled 旁路——队列非空时置 interrupted(Resume 横幅),对齐被跳过的旧路分支。 */
  onRunCancelled?: (threadId: string) => void
}

/**
 * 总线 envelope 的完整消费副作用(seq 去重 → 适配 → 入队 → streaming 态)。
 *
 * snapshot 来源(重载/切回线程的初始回放)同样注入事件,但不置 streaming:
 * F4 起旧路 hydrate(sidecar GET_THREAD_RUNTIME_EVENTS)对 events.jsonl 有事件的
 * 线程只投保留类,assistant/tool/run 历史单读总线快照——snapshot 是其唯一来源;
 * 旧线程 events.jsonl 为空,快照自然为空,注入无效果(旧路全量投影照旧)。此前
 * "snapshot 不入队"防的双份注入(runId 错位无法去重,场景 E)随 hydrate 过滤
 * 消失:已迁类不再有第二来源。求差基线(lastText/turnId)仍必须推进,否则后续
 * push 的累计 partial 会从空基线全量重发,与已注入文本叠加成双份。
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
  const applyTerminalStreamingEffects = () => {
    for (const event of events) {
      if (event.type === 'run.completed' || event.type === 'run.turn_limited') {
        ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
      } else if (event.type === 'run.cancelled') {
        // 批次5:旧路该类型的 streaming idle + queue-interrupted(Resume 横幅)副作用
        // 随跳过清单接管移到总线版
        ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
        ctx.onRunCancelled?.(threadId)
      } else if (event.type === 'run.failed') {
        ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: 'errored' }))
        ctx.setErrorMessages((prev) => ({ ...prev, [threadId]: event.error.message }))
      } else if (event.type === 'background.task.completed') {
        // 批次4:对齐旧路 useGlobalAgentListeners background.task.completed 分支的映射
        // (跳过清单接管该类型后,streaming 副作用由总线版承担)
        ctx.setStreamingStates((prev) => ({ ...prev, [threadId]: event.status === 'failed' ? 'errored' : 'idle' }))
      }
    }
  }
  if (source === 'snapshot') {
    // F4:注入但不动 streaming 态——历史回放不得把线程置为流式/错误态。
    // #416:终态副作用(清残留 streaming→idle/errored)仍要执行——切走线程的 push
    // 丢失、run 在后台完成后切回,afterSeq 快照是终态唯一来源,不清则线程永久卡
    // streaming(输入框停按钮悬空)。快照只禁止"置 streaming",不禁止"清 streaming"。
    for (const event of events) ctx.enqueueRuntimeEvent(event)
    applyTerminalStreamingEffects()
    return
  }
  for (const event of events) ctx.enqueueRuntimeEvent(event)
  // streaming 态副作用对齐旧 RUNTIME_EVENT 分支(该分支对跳过类型不再置位);
  // 仅 push 置位——快照回放悬空 run(无 run.end)不应把线程永久卡在流式态。
  if (envelope.kind === 'message' && envelope.phase !== 'end') {
    ctx.setStreamingStates((prev) => (
      prev[threadId] === 'streaming' ? prev : { ...prev, [threadId]: 'streaming' }
    ))
  }
  applyTerminalStreamingEffects()
}

/** 有状态纯函数:按事件顺序调用,state 由调用方持有(每线程一份)。 */
export function adaptLifecycleEvent(
  envelope: SdkEventEnvelope,
  state: LifecycleAdapterState,
): LumeRuntimeEvent[] {
  const detail = envelope.detail as SdkLifecycleDetail
  const base = {
    threadId: envelope.threadId,
    runId: envelope.runId,
    createdAt: new Date(envelope.ts).toISOString(),
  }

  if (detail.type === 'message.start') {
    state.turnId = envelope.turnId
    state.lastText = ''
    state.lastThinking = ''
    return []
  }

  if (detail.type === 'message.update') {
    // 防御:update 未 preceded by start 时按新 message 处理,避免拿上一轮基线求差
    if (envelope.turnId !== state.turnId) {
      state.turnId = envelope.turnId
      state.lastText = ''
      state.lastThinking = ''
    }
    const events: LumeRuntimeEvent[] = []
    // 批次1-4 落盘的旧 envelope 无 partial.thinking(events.jsonl 快照回放),缺省按空基线
    const thinking = detail.partial.thinking ?? ''
    const thinkingDelta = thinking.startsWith(state.lastThinking) ? thinking.slice(state.lastThinking.length) : ''
    state.lastThinking = thinking
    if (thinkingDelta) {
      events.push({
        id: `lifecycle:${envelope.seq}:assistant.thinking_delta`,
        type: 'assistant.thinking_delta' as const,
        ...base,
        delta: thinkingDelta,
      })
    }
    const text = detail.partial.text
    const delta = text.startsWith(state.lastText) ? text.slice(state.lastText.length) : ''
    state.lastText = text
    if (delta) {
      events.push({
        id: `lifecycle:${envelope.seq}:assistant.delta`,
        type: 'assistant.delta' as const,
        ...base,
        delta,
      })
    }
    return events
  }

  if (detail.type === 'message.end') {
    state.turnId = null
    state.lastText = ''
    state.lastThinking = ''
    const blocks = toFinalBlocks(detail.message.content)
    if (blocks.length === 0) return []
    return [{
      id: `lifecycle:${envelope.seq}:assistant.final`,
      type: 'assistant.final' as const,
      ...base,
      blocks,
    }]
  }

  // 批次2:tool 分支无状态(不触碰求差基线),快照重放天然幂等。
  if (detail.type === 'tool.start') {
    return [{
      id: `lifecycle:${envelope.seq}:tool.started`,
      type: 'tool.started' as const,
      ...base,
      toolCallId: detail.toolCallId,
      toolName: detail.toolName,
      inputPreview: detail.input,
    }]
  }

  if (detail.type === 'tool.end') {
    // 批次2.1 补:execution/resultRef 从 detail.meta.execution(engine _meta 原样透传)
    // 做 web 侧最小归一——校验对齐旧路 normalizeToolExecutionMetadata,形态不合法整体
    // 省略;session fileRef 富化(sidecar sessionArtifactFileRef)是 sidecar 专属,减配留档。
    const execution = normalizeToolExecutionMetadata(detail.meta?.execution)
    const resultRef = execution?.resultRef
    if (detail.isError) {
      return [{
        id: `lifecycle:${envelope.seq}:tool.failed`,
        type: 'tool.failed' as const,
        ...base,
        toolCallId: detail.toolCallId,
        toolName: detail.toolName,
        error: { code: 'tool_error', message: detail.output },
        ...(execution ? { execution } : {}),
        ...(resultRef ? { resultRef } : {}),
      }]
    }
    return [{
      id: `lifecycle:${envelope.seq}:tool.completed`,
      type: 'tool.completed' as const,
      ...base,
      toolCallId: detail.toolCallId,
      toolName: detail.toolName,
      resultPreview: detail.output,
      ...(execution ? { execution } : {}),
      ...(resultRef ? { resultRef } : {}),
    }]
  }

  // 批次5:run.start → run.started(此前"不产"分支翻转——旧路该类型仅 replay/hydrate
  // 产生,live 从未推送;总线版接管 live 后跳过清单覆盖旧路 live 分支)。
  // workspaceId/workspaceSlug/model 信封不携带(RunStartedRuntimeEvent 全可选)——
  // model.contextWindow 富化减配留档(T6 runId 统一后由 events.jsonl 单源接管)。
  if (detail.type === 'run.start') {
    return [{
      id: `lifecycle:${envelope.seq}:run.started`,
      type: 'run.started' as const,
      ...base,
    }]
  }

  if (detail.type === 'run.end') {
    state.turnId = null
    state.lastText = ''
    state.lastThinking = ''
    const event = adaptRunEnd(envelope, detail, base)
    return event ? [event] : []
  }

  // 批次3:memory 领域事件(run 级 kind='run' phase='event',判别走 detail.type)。
  // 无状态(不触碰求差基线),快照重放天然幂等;snapshot 版不入队由旧路 hydrate
  // replay 覆盖,投影 memory 分支 filter+push 幂等吸收双投(已知安全)。
  // detail.items 为宽标注(sidecar 透传,claim 实际是对象),与旧路事件 items
  // 运行时同构——原样引用透传,不做字段级重建。
  if (detail.type === 'memory.context.used') {
    return [{
      id: `lifecycle:${envelope.seq}:memory.context.used`,
      type: 'memory.context.used' as const,
      ...base,
      items: detail.items as MemoryContextUsedRuntimeEvent['items'],
    }]
  }

  // 批次4:background.task 领域事件(late task_notification 旁路 + projector 主流双入口,
  // 同一 detail 形态)→ 旧路 background.task.completed。字段对齐旧路
  // projectBackgroundTaskNotificationRuntimeEvent:taskId/status/message/summary/execution
  // (outputFile/toolUseId/usage 骨架不携带,减配留档);旧路恒定 id 的去重语义跨入口
  // 无稳定键可复刻——但两入口同一事件只走其一,无双发。
  if (detail.type === 'background.task') {
    return [{
      id: `lifecycle:${envelope.seq}:background.task.completed`,
      type: 'background.task.completed' as const,
      ...base,
      taskId: detail.taskId,
      status: detail.status,
      ...(detail.message !== undefined ? { message: detail.message } : {}),
      ...(detail.summary !== undefined ? { summary: detail.summary } : {}),
      // detail.execution 标注为 unknown(sidecar 原样透传 engine 的 ToolExecutionMetadata),
      // 与旧路运行时同构——引用透传,宽标注处 cast(同批次3 items 模式)
      ...(detail.execution !== undefined
        ? { execution: detail.execution as Extract<LumeRuntimeEvent, { type: 'background.task.completed' }>['execution'] }
        : {}),
    }]
  }

  // 批次5:todo.state → 旧路 todo.state_updated。detail.state 为旧路载荷(todos/
  // currentActiveForm,T4 第二入口同引用)——宽标注处 cast,原样透传(同批次3 items 模式)。
  if (detail.type === 'todo.state') {
    const payload = detail.state as { todos?: unknown; currentActiveForm?: unknown } | null | undefined
    if (!payload || typeof payload !== 'object') return []
    return [{
      id: `lifecycle:${envelope.seq}:todo.state_updated`,
      type: 'todo.state_updated' as const,
      ...base,
      todos: payload.todos as Extract<LumeRuntimeEvent, { type: 'todo.state_updated' }>['todos'],
      currentActiveForm: (payload.currentActiveForm ?? null) as Extract<LumeRuntimeEvent, { type: 'todo.state_updated' }>['currentActiveForm'],
    }]
  }

  // 批次5:advisor.reviewed → 旧路同形(severity 白名单外丢弃、summary/modelRef 旧路
  // 默认值,对齐 run-item-events advisor_reviewed 分支)。detail.review 为旧路载荷同引用。
  if (detail.type === 'advisor.reviewed') {
    const review = detail.review as Record<string, unknown> | null | undefined
    if (!review || typeof review !== 'object') return []
    const severity = review.severity
    if (severity !== 'clear' && severity !== 'suggestion' && severity !== 'concern' && severity !== 'blocker') return []
    return [{
      id: `lifecycle:${envelope.seq}:advisor.reviewed`,
      type: 'advisor.reviewed' as const,
      ...base,
      severity,
      summary: nonEmptyString(review.summary) ?? 'Advisor review completed',
      ...(nonEmptyString(review.details) ? { details: nonEmptyString(review.details) } : {}),
      modelRef: nonEmptyString(review.modelRef) ?? 'unknown',
      ...(typeof review.durationMs === 'number' ? { durationMs: review.durationMs } : {}),
    }]
  }

  // 批次5:coding.report → 旧路 coding.report.updated。detail.report 与旧路 codingReport
  // 同引用(T1 终表判迁:run.completed/coding.report 双入口)——宽标注处 cast 透传。
  if (detail.type === 'coding.report') {
    return [{
      id: `lifecycle:${envelope.seq}:coding.report.updated`,
      type: 'coding.report.updated' as const,
      ...base,
      codingReport: detail.report as Extract<LumeRuntimeEvent, { type: 'coding.report.updated' }>['codingReport'],
    }]
  }

  // 批次4:context.compaction 三态 → 旧路同形 RuntimeEvent。trigger 真值已透传
  // (加固批次起 projector 携带 detail.trigger;缺省回落 'auto');policy/source/
  // stage 用旧路默认值;preTokens/postTokens 逐事件透传——ContextWindowIndicator 与
  // runtime-state-projections 真实消费,缺省不可恢复;progress 做旧路 clampProgress
  // 防御复制;completed 的 outcome 由 detail.isError 等价折叠(与 detail.outcome 一致)。
  // result→summary/failureReason 与 retained* 骨架不携带,减配留档(删旧路时随总线侧补齐)。
  if (detail.type === 'context.compaction') {
    const compactionBase = {
      trigger: detail.trigger ?? 'auto',
      preTokens: detail.preTokens ?? 0,
      policy: 'sdk-default',
      source: 'agent-sdk',
    }
    if (detail.phase === 'progress') {
      return [{
        id: `lifecycle:${envelope.seq}:context.compaction.progress`,
        type: 'context.compaction.progress' as const,
        ...base,
        ...compactionBase,
        stage: 'summarizing',
        progress: clampCompactionProgress(detail.progress ?? 0),
      }]
    }
    return [{
      id: `lifecycle:${envelope.seq}:context.compaction.${detail.phase}`,
      type: detail.phase === 'completed'
        ? 'context.compaction.completed' as const
        : 'context.compaction.started' as const,
      ...base,
      ...compactionBase,
      ...(detail.phase === 'completed'
        ? {
          outcome: detail.isError === true ? 'failed' as const : 'succeeded' as const,
          ...(detail.postTokens !== undefined ? { postTokens: detail.postTokens } : {}),
        }
        : {}),
    }]
  }

  if (detail.type === 'tool.output') {
    // 前台工具输出快照(Bash)。id 故意不走 envelope.seq 派生:同一 toolCallId 的
    // 连续快照在 runtime-event-state 按此稳定 id 原地替换(事件数组恒占 1 条)。
    // hydrate 的 mergeHydratedRuntimeEvents 对同 id 是 first-wins——当前两条来源
    // 不会同 id 相遇(persisted 白名单不含 tool.output,live 已单槽收敛);若未来
    // 持久层出现多份,重开线程会保留最旧快照,届时需同步调整去重方向。
    return [{
      id: `${envelope.runId}:tool-output:${detail.toolCallId}`,
      type: 'tool.output',
      ...base,
      toolCallId: detail.toolCallId,
      chunk: detail.chunk,
    }]
  }

  // turn.* / 未知事件(含未迁移领域事件 memory.changed 等):不产 RuntimeEvent。
  // 批次5 裁定不映射:user.message(旧路 message.user.submitted 继续驱动,projector
  // 分支留作 SDK 未来 emitter 接收端)/plan.preview(旧路休眠,无写入者)/
  // task.progress(SDK 后台进度 taskId/description/usage,与旧路 Task 清单事件——
  // 源于 task-tools 而非 SDK 流——不同物,无旧路等价 RuntimeEvent)。
  return []
}

function adaptRunEnd(
  envelope: SdkEventEnvelope,
  detail: Extract<SdkLifecycleDetail, { type: 'run.end' }>,
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
  // 中止:批次5 翻转——projector 已补流中止终值(流结束无 result 时补发
  // run.end{stopReason:'aborted'},T3),run.cancelled 改由总线产;streaming idle 与
  // queue-interrupted(Resume 横幅)副作用见 consumeBusEnvelope(旧路 live 分支
  // 已被跳过清单接管)。
  if (detail.stopReason === 'aborted') {
    return {
      id: `lifecycle:${envelope.seq}:run.cancelled`,
      type: 'run.cancelled',
      ...base,
    }
  }
  // 防护性终止(error_completion_guard):SDK 内部重复调用熔断与宿主自有
  // completionGuard stop 共用该 subtype,#472 起靠 projector 透传的 errorCode
  // 分流文案;无码(旧事件)回落 repeat-guard 文案。
  if (detail.stopReason?.includes('completion_guard')) {
    const guardCopy = detail.errorCode === 'verification_inconclusive'
      ? { code: 'verification_inconclusive', message: '验证结果无法确认，已由保护机制停止；当前进度已保存。' }
      : detail.errorCode === 'verification_failed_after_repair'
        ? { code: 'verification_failed_after_repair', message: '验证在自动修复后仍未通过，已由保护机制停止；当前进度已保存。' }
        : { code: 'repeated_tool_call', message: '本轮检测到重复执行相同操作，已由保护机制停止；当前进度已保存。' }
    return {
      id: `lifecycle:${envelope.seq}:run.failed`,
      type: 'run.failed',
      ...base,
      error: guardCopy,
    }
  }
  if (detail.isError) {
    return {
      id: `lifecycle:${envelope.seq}:run.failed`,
      type: 'run.failed',
      ...base,
      error: { code: 'runtime_error', message: detail.result ?? detail.stopReason ?? 'Run failed' },
    }
  }
  return {
    id: `lifecycle:${envelope.seq}:run.completed`,
    type: 'run.completed',
    ...base,
  }
}

/** 与旧路 run-item-events clampProgress 同款防御复制(骨架透传原值,钳制职责在适配器)。 */
function clampCompactionProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** 与旧路 run-item-events stringValue 同款(空串/非 string → undefined)。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

const TOOL_TERMINATION_REASONS = new Set([
  'completed', 'nonzero', 'timeout', 'aborted', 'output_limit', 'spawn_error', 'running', 'interrupted',
])
const TOOL_V2_OUTCOMES = new Set([
  'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted',
])
const TOOL_SEMANTIC_OUTCOMES = new Set(['no_matches', 'condition_false', 'files_differ'])

/**
 * 批次2.1:engine _meta.execution 的 web 侧最小归一——校验与旧路 run-item-events
 * normalizeToolExecutionMetadata 逐字对齐(version/command/durationMs/terminationReason
 * 必填,v2 另验 outcome/shell;不合法整体 undefined),差异仅一处:resultRef 的 fileRef
 * 富化依赖 sidecar session 工件路径解析(sessionArtifactFileRef),web 侧无 binding,
 * 留档减配(T7b 归一收编时评估上收 shared)。
 */
function normalizeToolExecutionMetadata(value: unknown): ToolExecutionMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const terminationReason = record.terminationReason
  if ((record.version !== 1 && record.version !== 2) || typeof record.command !== 'string' || typeof record.durationMs !== 'number') return undefined
  if (typeof terminationReason !== 'string' || !TOOL_TERMINATION_REASONS.has(terminationReason)) return undefined
  const resultRef = normalizeFileResultRef(record.resultRef)
  if (record.version === 2) {
    const outcome = record.outcome
    if (typeof outcome !== 'string' || !TOOL_V2_OUTCOMES.has(outcome)) return undefined
    if (record.shell !== 'bash' && record.shell !== 'powershell') return undefined
    const stdoutRef = normalizeFileResultRef(record.stdoutRef)
    const stderrRef = normalizeFileResultRef(record.stderrRef)
    return {
      version: 2,
      outcome: outcome as Extract<ToolExecutionMetadata, { version: 2 }>['outcome'],
      ...(typeof record.exitCode === 'number' || record.exitCode === null ? { exitCode: record.exitCode } : {}),
      ...(typeof record.stdoutPreview === 'string' ? { stdoutPreview: record.stdoutPreview } : {}),
      ...(typeof record.stderrPreview === 'string' ? { stderrPreview: record.stderrPreview } : {}),
      ...(stdoutRef ? { stdoutRef } : {}),
      ...(stderrRef ? { stderrRef } : {}),
      ...(typeof record.timedOut === 'boolean' ? { timedOut: record.timedOut } : {}),
      ...(typeof record.aborted === 'boolean' ? { aborted: record.aborted } : {}),
      ...(typeof record.outputLimitReached === 'boolean' ? { outputLimitReached: record.outputLimitReached } : {}),
      durationMs: record.durationMs,
      command: record.command,
      shell: record.shell,
      ...(isSemanticOutcome(record.semanticOutcome) ? { semanticOutcome: record.semanticOutcome } : {}),
      ...(typeof record.purpose === 'string' ? { purpose: record.purpose } : {}),
      ...(typeof record.workspaceChanged === 'boolean' ? { workspaceChanged: record.workspaceChanged } : {}),
      ...(resultRef ? { resultRef } : {}),
      terminationReason: terminationReason as Extract<ToolExecutionMetadata, { version: 2 }>['terminationReason'],
    }
  }
  if (terminationReason === 'interrupted') return undefined
  return {
    version: 1,
    ...(typeof record.exitCode === 'number' || record.exitCode === null ? { exitCode: record.exitCode } : {}),
    ...(typeof record.stdoutPreview === 'string' ? { stdoutPreview: record.stdoutPreview } : {}),
    ...(typeof record.stderrPreview === 'string' ? { stderrPreview: record.stderrPreview } : {}),
    ...(typeof record.timedOut === 'boolean' ? { timedOut: record.timedOut } : {}),
    ...(typeof record.aborted === 'boolean' ? { aborted: record.aborted } : {}),
    ...(typeof record.outputLimitReached === 'boolean' ? { outputLimitReached: record.outputLimitReached } : {}),
    durationMs: record.durationMs,
    command: record.command,
    ...(record.shell === 'bash' || record.shell === 'powershell' ? { shell: record.shell } : {}),
    ...(isSemanticOutcome(record.semanticOutcome) ? { semanticOutcome: record.semanticOutcome } : {}),
    ...(typeof record.purpose === 'string' ? { purpose: record.purpose } : {}),
    ...(typeof record.workspaceChanged === 'boolean' ? { workspaceChanged: record.workspaceChanged } : {}),
    ...(resultRef ? { resultRef } : {}),
    terminationReason: terminationReason as Extract<ToolExecutionMetadata, { version: 1 }>['terminationReason'],
  }
}

/** 与旧路 normalizeFileResultRef 同款(kind/path/size gate),fileRef 富化 sidecar 专属。 */
function normalizeFileResultRef(value: unknown): FileResultRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'file' || typeof record.path !== 'string' || typeof record.size !== 'number') return undefined
  return {
    kind: 'file',
    path: record.path,
    size: record.size,
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
  }
}

function isSemanticOutcome(value: unknown): value is 'no_matches' | 'condition_false' | 'files_differ' {
  return typeof value === 'string' && TOOL_SEMANTIC_OUTCOMES.has(value)
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
