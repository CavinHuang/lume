/**
 * LifecycleProjector — pure state machine projecting the engine's SDKMessage
 * stream into lifecycle skeleton events (run / turn / assistant message).
 *
 * Batch 1 scope. The engine itself is untouched: this generator wraps whatever
 * AsyncIterable<SDKMessage> it is given (Task 4 wires it in the sidecar).
 */
import { randomUUID } from 'node:crypto'
import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKStreamEventMessage } from '../types.js'
import type {
  SdkLifecycleEvent,
  Batch1LifecycleDetail,
  RunEndDetail,
  TurnEndDetail,
  MessageEndDetail,
  MessageUpdateDetail,
} from '@lume/shared'

interface PendingTurn {
  turnId: string
  /** Whether turnId came from an assistant uuid (vs positional fallback). */
  uuidAssigned: boolean
  /** Expected tool_result count (from the assistant's tool_use blocks). */
  expectedToolResults: number
  toolResults: TurnEndDetail['toolResults']
  assistantMessage: { role: 'assistant'; content: unknown[] } | null
  messageStarted: boolean
  partialText: string
  /** Folding slots per streaming content_block index. */
  partialToolUses: Map<number, { id: string; name: string; partialJson: string }>
}

const DELTA_FAMILY = new Set(['text_delta', 'input_json_delta', 'thinking_delta'])

export async function* projectLifecycle(
  messages: AsyncIterable<SDKMessage>,
): AsyncGenerator<SdkLifecycleEvent<Batch1LifecycleDetail>> {
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
    detail: Batch1LifecycleDetail,
  ): SdkLifecycleEvent<Batch1LifecycleDetail> => ({ runId, turnId, ts: ts(), kind, phase, detail })

  /** Run boundary: first assistant/stream_event/tool_result opens the run. */
  function ensureRunStarted(): SdkLifecycleEvent<Batch1LifecycleDetail> | null {
    if (runStarted) return null
    runStarted = true
    return emit('run', 'start', null, { type: 'run.start' })
  }

  /** Turn boundary: turnId = assistant uuid, with positional fallback. */
  function openTurn(uuid?: string): PendingTurn {
    turnCounter += 1
    const turn: PendingTurn = {
      turnId: uuid ?? `turn-${turnCounter}`,
      uuidAssigned: uuid !== undefined,
      expectedToolResults: 0,
      toolResults: [],
      assistantMessage: null,
      messageStarted: false,
      partialText: '',
      partialToolUses: new Map(),
    }
    return turn
  }

  /** Fold a content_block_delta family event into the cumulative partial. */
  function foldDelta(turn: PendingTurn, event: SDKStreamEventMessage['event']): void {
    const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined
    if (!delta) return
    if (delta.type === 'text_delta') {
      turn.partialText += delta.text ?? ''
    } else if (delta.type === 'input_json_delta' || delta.type === 'thinking_delta') {
      const index = (event.index as number) ?? 0
      const slot = turn.partialToolUses.get(index) ?? { id: '', name: '', partialJson: '' }
      slot.partialJson += delta.partial_json ?? ''
      turn.partialToolUses.set(index, slot)
    }
  }

  /** Stream events: first any stream_event opens turn + message; delta family folds + updates. */
  function handleStreamEvent(message: SDKStreamEventMessage): SdkLifecycleEvent<Batch1LifecycleDetail>[] {
    const out: SdkLifecycleEvent<Batch1LifecycleDetail>[] = []
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
      foldDelta(currentTurn, message.event)
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
  function handleAssistant(message: SDKAssistantMessage): SdkLifecycleEvent<Batch1LifecycleDetail>[] {
    const out: SdkLifecycleEvent<Batch1LifecycleDetail>[] = []
    const runStart = ensureRunStarted()
    if (runStart) out.push(runStart)
    if (!currentTurn) {
      currentTurn = openTurn(message.uuid)
      out.push(emit('turn', 'start', currentTurn.turnId, { type: 'turn.start' }))
    } else if (!currentTurn.uuidAssigned && message.uuid) {
      // Streaming opened the turn before the uuid was known — adopt it now.
      currentTurn.turnId = message.uuid
      currentTurn.uuidAssigned = true
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
   * tool_result: recorded by tool_use_id; the turn ends once the result count
   * reaches the assistant's tool_use count (count-based pairing — engine
   * replayed assistants may carry regenerated tool_use ids).
   */
  function handleToolResult(result: { tool_use_id: string; tool_name?: string; output?: string; is_error?: boolean }): SdkLifecycleEvent<Batch1LifecycleDetail>[] {
    if (!currentTurn || currentTurn.expectedToolResults === 0) return []
    currentTurn.toolResults.push({
      tool_use_id: result.tool_use_id,
      tool_name: result.tool_name,
      content: result.output,
      is_error: result.is_error,
    })
    if (currentTurn.toolResults.length >= currentTurn.expectedToolResults) {
      const turn = currentTurn
      currentTurn = null
      return [endTurn(turn)]
    }
    return []
  }

  function endTurn(turn: PendingTurn): SdkLifecycleEvent<Batch1LifecycleDetail> {
    const detail: TurnEndDetail = {
      type: 'turn.end',
      assistantMessage: turn.assistantMessage ?? { role: 'assistant', content: [] },
      toolResults: turn.toolResults,
    }
    return emit('turn', 'end', turn.turnId, detail)
  }

  /** Legacy result message → run.end (detail migrated from the legacy fields). */
  function endRun(result: SDKResultMessage): SdkLifecycleEvent<Batch1LifecycleDetail>[] {
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
    let events: SdkLifecycleEvent<Batch1LifecycleDetail>[] = []
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
      default:
        break
    }
    for (const event of events) yield event
  }
  // Stream ends without a result message: no run.end here — the sidecar's legacy
  // result path is the fallback source of truth (accepted for batch 1).
}
