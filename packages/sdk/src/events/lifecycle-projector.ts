/**
 * LifecycleProjector — pure state machine projecting the engine's SDKMessage
 * stream into lifecycle skeleton events (run / turn / assistant message / tool).
 *
 * Batch 1 scope. The engine itself is untouched: this generator wraps whatever
 * AsyncIterable<SDKMessage> it is given (Task 4 wires it in the sidecar).
 */
import { randomUUID } from 'node:crypto'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKStreamEventMessage,
  SDKContextCompactionStartedMessage,
  SDKContextCompactionProgressMessage,
  SDKCompactBoundaryMessage,
  SDKTaskNotificationMessage,
} from '../types.js'
import type {
  SdkLifecycleEvent,
  SdkLifecycleDetail,
  RunEndDetail,
  TurnEndDetail,
  MessageEndDetail,
  MessageUpdateDetail,
  ToolStartDetail,
  ToolEndDetail,
  BackgroundTaskNotificationDetail,
  ContextCompactionDetail,
} from '@lume/shared'

interface PendingTurn {
  turnId: string
  /** tool_use ids from the assistant message, consumed as results pair up. */
  pendingToolUseIds: Set<string>
  /** tool_use ids already announced via tool.start (idempotent across replays). */
  startedToolIds: Set<string>
  /** Total tool_use blocks in the assistant message (count-based fallback). */
  expectedToolResults: number
  toolResults: TurnEndDetail['toolResults']
  assistantMessage: { role: 'assistant'; content: unknown[] } | null
  messageStarted: boolean
  partialText: string
  /** Folding slots per streaming content_block index. */
  partialToolUses: Map<number, { id: string; name: string; partialJson: string }>
}

const DELTA_FAMILY = new Set(['text_delta', 'input_json_delta', 'thinking_delta'])

/**
 * Legacy parity (run-item-events.ts normalizeBackgroundTaskStatus): only the
 * four terminal statuses map; attention and unknown statuses are dropped.
 */
function normalizeTaskNotificationStatus(status: string): BackgroundTaskNotificationDetail['status'] | undefined {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'stopped' || status === 'killed') return 'stopped'
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  return undefined
}

export async function* projectLifecycle(
  messages: AsyncIterable<SDKMessage>,
): AsyncGenerator<SdkLifecycleEvent<SdkLifecycleDetail>> {
  const runId = randomUUID()
  const ts = () => Date.now()
  let runStarted = false
  let runEnded = false
  let turnCounter = 0
  let currentTurn: PendingTurn | null = null

  const emit = (
    kind: SdkLifecycleEvent['kind'],
    phase: SdkLifecycleEvent['phase'],
    turnId: string | null,
    detail: SdkLifecycleDetail,
  ): SdkLifecycleEvent<SdkLifecycleDetail> => ({ runId, turnId, ts: ts(), kind, phase, detail })

  /** Run boundary: first assistant/stream_event/tool_result opens the run. */
  function ensureRunStarted(): SdkLifecycleEvent<SdkLifecycleDetail> | null {
    if (runStarted) return null
    runStarted = true
    return emit('run', 'start', null, { type: 'run.start' })
  }

  /**
   * Turn boundary: turnId is the stable positional id `turn-<n>` — it is the
   * event bus join key, so it must never change mid-turn. The assistant uuid
   * stays reachable via detail.assistantMessage.
   */
  function openTurn(): PendingTurn {
    turnCounter += 1
    const turn: PendingTurn = {
      turnId: `turn-${turnCounter}`,
      pendingToolUseIds: new Set(),
      startedToolIds: new Set(),
      expectedToolResults: 0,
      toolResults: [],
      assistantMessage: null,
      messageStarted: false,
      partialText: '',
      partialToolUses: new Map(),
    }
    return turn
  }

  /**
   * Fold a content_block_delta family event into the cumulative partial.
   * thinking_delta is NOT folded in batch 1 — it only rides the update's
   * passthrough delta (partial.thinking lands in batch 2).
   */
  function foldDelta(turn: PendingTurn, event: SDKStreamEventMessage['event']): void {
    const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined
    if (!delta) return
    if (delta.type === 'text_delta') {
      turn.partialText += delta.text ?? ''
    } else if (delta.type === 'input_json_delta') {
      const index = (event.index as number) ?? 0
      const slot = turn.partialToolUses.get(index) ?? { id: '', name: '', partialJson: '' }
      slot.partialJson += delta.partial_json ?? ''
      turn.partialToolUses.set(index, slot)
    }
  }

  /** Stream events: first any stream_event opens turn + message; delta family folds + updates. */
  function handleStreamEvent(message: SDKStreamEventMessage): SdkLifecycleEvent<SdkLifecycleDetail>[] {
    const out: SdkLifecycleEvent<SdkLifecycleDetail>[] = []
    const runStart = ensureRunStarted()
    if (runStart) out.push(runStart)
    if (!currentTurn) {
      currentTurn = openTurn()
      out.push(emit('turn', 'start', currentTurn.turnId, { type: 'turn.start' }))
    }
    if (!currentTurn.messageStarted) {
      currentTurn.messageStarted = true
      out.push(emit('message', 'start', currentTurn.turnId, { type: 'message.start' }))
    }
    const deltaType = (message.event.delta as { type?: string } | undefined)?.type
    if (message.event.type === 'content_block_delta' && deltaType && DELTA_FAMILY.has(deltaType)) {
      // thinking_delta passes through without folding (see foldDelta).
      if (deltaType !== 'thinking_delta') foldDelta(currentTurn, message.event)
      const detail: MessageUpdateDetail = {
        type: 'message.update',
        delta: message.event,
        partial: {
          text: currentTurn.partialText,
          toolUses: [...currentTurn.partialToolUses.values()],
        },
      }
      out.push(emit('message', 'update', currentTurn.turnId, detail))
    }
    return out
  }

  /** Assistant final value: message.end (+ turn.end when no tool_use or error). */
  function handleAssistant(message: SDKAssistantMessage): SdkLifecycleEvent<SdkLifecycleDetail>[] {
    const out: SdkLifecycleEvent<SdkLifecycleDetail>[] = []
    const runStart = ensureRunStarted()
    if (runStart) out.push(runStart)
    if (!currentTurn) {
      currentTurn = openTurn()
      out.push(emit('turn', 'start', currentTurn.turnId, { type: 'turn.start' }))
    }
    // No-streaming degrade: keep the skeleton complete with a late message.start.
    if (!currentTurn.messageStarted) {
      currentTurn.messageStarted = true
      out.push(emit('message', 'start', currentTurn.turnId, { type: 'message.start' }))
    }
    const msgEndDetail: MessageEndDetail = {
      type: 'message.end',
      message: message.message,
    }
    if (message.error) msgEndDetail.error = message.error
    out.push(emit('message', 'end', currentTurn.turnId, msgEndDetail))

    currentTurn.assistantMessage = message.message
    for (const block of message.message.content) {
      if ((block as { type?: string }).type === 'tool_use') {
        currentTurn.expectedToolResults += 1
        const toolUse = block as { id?: string; name?: string; input?: unknown }
        currentTurn.pendingToolUseIds.add(toolUse.id ?? '')
        // tool.start skeleton in content order; skipped on the error chain (the
        // tools never ran, so no dangling start) and idempotent across replays.
        if (!message.error && !currentTurn.startedToolIds.has(toolUse.id ?? '')) {
          currentTurn.startedToolIds.add(toolUse.id ?? '')
          const detail: ToolStartDetail = {
            type: 'tool.start',
            toolCallId: toolUse.id ?? '',
            toolName: toolUse.name ?? '',
            input: toolUse.input,
          }
          out.push(emit('tool', 'start', currentTurn.turnId, detail))
        }
      }
    }

    if (message.error) {
      // Abort/error chain: turn ends empty-handed and the run ends immediately.
      out.push(endTurn(currentTurn))
      out.push(...endRun({ subtype: 'error_during_execution', is_error: true } as SDKResultMessage))
      currentTurn = null
      return out
    }
    if (currentTurn.expectedToolResults === 0) {
      out.push(endTurn(currentTurn))
      currentTurn = null
    }
    return out
  }

  /**
   * tool_result pairing: id hit first, count fallback second. A result whose
   * tool_use_id matches a pending id pairs by id; an id miss still fills a
   * slot while the turn is under-filled (tolerates regenerated ids); once the
   * turn is full, extra results are orphans and ignored.
   */
  function handleToolResult(result: { tool_use_id: string; tool_name?: string; output?: string; is_error?: boolean; _meta?: Record<string, unknown> }): SdkLifecycleEvent<SdkLifecycleDetail>[] {
    const out: SdkLifecycleEvent<SdkLifecycleDetail>[] = []
    const runStart = ensureRunStarted()
    if (runStart) out.push(runStart)
    if (!currentTurn || currentTurn.expectedToolResults === 0) return out
    const idHit = currentTurn.pendingToolUseIds.has(result.tool_use_id)
    const underFilled = currentTurn.toolResults.length < currentTurn.expectedToolResults
    if (!idHit && !underFilled) return out // orphan
    if (idHit) currentTurn.pendingToolUseIds.delete(result.tool_use_id)
    // tool.end before the pairing close below keeps it ahead of turn.end.
    const toolEndDetail: ToolEndDetail = {
      type: 'tool.end',
      toolCallId: result.tool_use_id,
      toolName: result.tool_name ?? '',
      isError: result.is_error === true,
      output: result.output ?? '',
    }
    if (result._meta !== undefined) toolEndDetail.meta = result._meta
    out.push(emit('tool', 'end', currentTurn.turnId, toolEndDetail))
    currentTurn.toolResults.push({
      tool_use_id: result.tool_use_id,
      tool_name: result.tool_name,
      content: result.output,
      is_error: result.is_error,
    })
    if (currentTurn.toolResults.length >= currentTurn.expectedToolResults) {
      const turn = currentTurn
      currentTurn = null
      out.push(endTurn(turn))
    }
    return out
  }

  function endTurn(turn: PendingTurn): SdkLifecycleEvent<SdkLifecycleDetail> {
    const detail: TurnEndDetail = {
      type: 'turn.end',
      assistantMessage: turn.assistantMessage ?? { role: 'assistant', content: [] },
      toolResults: turn.toolResults,
    }
    return emit('turn', 'end', turn.turnId, detail)
  }

  /**
   * System-family domain events: compaction tri-state + in-run task_notification.
   * Pure domain skeletons (kind 'run'/phase 'event'/turnId null) — they never
   * open the run nor join turn pairing (orthogonal to the message/tool stream).
   * Subagent forms are already skipped at the loop entry.
   */
  function handleSystem(message: SDKMessage): SdkLifecycleEvent<SdkLifecycleDetail>[] {
    const subtype = (message as { subtype?: string }).subtype
    if (subtype === 'context_compaction_started') {
      const meta = (message as SDKContextCompactionStartedMessage).compact_metadata
      const detail: ContextCompactionDetail = { type: 'context.compaction', phase: 'started' }
      if (typeof meta?.pre_tokens === 'number') detail.preTokens = meta.pre_tokens
      return [emit('run', 'event', null, detail)]
    }
    if (subtype === 'context_compaction_progress') {
      const meta = (message as SDKContextCompactionProgressMessage).compact_metadata
      const detail: ContextCompactionDetail = { type: 'context.compaction', phase: 'progress' }
      if (typeof meta?.pre_tokens === 'number') detail.preTokens = meta.pre_tokens
      if (typeof meta.progress === 'number') detail.progress = meta.progress
      return [emit('run', 'event', null, detail)]
    }
    if (subtype === 'compact_boundary') {
      const meta = (message as SDKCompactBoundaryMessage).compact_metadata
      const failed = meta?.outcome === 'failed'
      const detail: ContextCompactionDetail = { type: 'context.compaction', phase: 'completed', isError: failed }
      if (typeof meta?.pre_tokens === 'number') detail.preTokens = meta.pre_tokens
      if (typeof meta?.post_tokens === 'number') detail.postTokens = meta.post_tokens
      const result = failed ? meta?.failure_reason : meta?.summary
      if (typeof result === 'string' && result) detail.result = result
      return [emit('run', 'event', null, detail)]
    }
    if (subtype === 'task_notification') {
      const task = message as SDKTaskNotificationMessage
      const status = normalizeTaskNotificationStatus(task.status)
      if (!status) return []
      const detail: BackgroundTaskNotificationDetail = { type: 'background.task', taskId: task.task_id, status }
      if (typeof task.message === 'string') detail.message = task.message
      if (typeof task.summary === 'string') detail.summary = task.summary
      if (task.execution !== undefined) detail.execution = task.execution
      return [emit('run', 'event', null, detail)]
    }
    return []
  }

  /** Legacy result message → run.end (detail migrated from the legacy fields). */
  function endRun(result: SDKResultMessage): SdkLifecycleEvent<SdkLifecycleDetail>[] {
    if (runEnded) return []
    runEnded = true
    const detail: RunEndDetail = {
      type: 'run.end',
      stopReason: result.stop_reason ?? (result.subtype === 'success' ? 'end_turn' : result.subtype),
      isError: result.is_error === true || result.subtype.startsWith('error_'),
      numTurns: result.num_turns ?? 0,
    }
    if (result.usage !== undefined) detail.usage = result.usage as unknown as Record<string, unknown>
    if (result.total_cost_usd !== undefined) detail.costUSD = result.total_cost_usd
    return [emit('run', 'end', null, detail)]
  }

  for await (const message of messages) {
    if ((message as { subagent_run_id?: string }).subagent_run_id) continue
    let events: SdkLifecycleEvent<SdkLifecycleDetail>[] = []
    switch (message.type) {
      case 'stream_event':
        events = handleStreamEvent(message)
        break
      case 'assistant':
        events = handleAssistant(message)
        break
      case 'tool_result':
        events = handleToolResult(message.result)
        break
      case 'result':
        events = endRun(message)
        break
      case 'system':
        events = handleSystem(message)
        break
      default:
        break
    }
    for (const event of events) yield event
  }
  // Stream ends without a result message: no run.end here — the sidecar's legacy
  // result path is the fallback source of truth (accepted for batch 1).
}
