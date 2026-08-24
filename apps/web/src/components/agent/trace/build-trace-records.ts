/**
 * Trace 投影：SdkEventEnvelope 流 → turn 分组的轨迹记录。
 *
 * 纯函数、无状态；输入为线程事件总线快照+推送的累计集合（乱序容忍，按 seq 排序）。
 * 映射规则对齐 packages/sdk/src/events/lifecycle-projector.ts 的发射约定：
 * - user 消息：kind=message 且 detail.type=user.message（turnId 为 null，先于对应 turn.start）
 * - assistant：message.start(有 turnId) 开记录，message.update 折叠流式预览，message.end 收口
 * - tool：tool.start/end 按 toolCallId 配对；未配对保持运行态
 * - compaction 只取 completed 相位；run.end 产出运行汇总行
 * - 其余域事件（plan/todo/task.progress 等）v1 不入账本
 *
 * 注意：turnNumber 是账本内递增的「轮次序号」（第 N 个 turn.start 之后），
 * 跨多个 run 持续累加，与 SDK 的 turnId（每 run 重置）不同。
 */
import type { SdkEventEnvelope } from '@lume/shared'
import type {
  ContextCompactionDetail,
  MessageEndDetail,
  MessageUpdateDetail,
  RunEndDetail,
  ToolEndDetail,
  ToolStartDetail,
  UserMessageDetail,
} from '@lume/shared'

export type TraceRecordKind = 'user' | 'assistant' | 'tool' | 'compaction' | 'run'

export interface TraceRecord {
  /** 创建该记录的 envelope seq，稳定唯一。 */
  id: string
  /** 1-based 账本序号（#N）。 */
  index: number
  kind: TraceRecordKind
  /** 所属轮次（第 N 个 turn.start 之后），user 消息与运行边界为 null。 */
  turnNumber: number | null
  /** 单行摘要（账本直接展示）。 */
  summary: string
  startedAt: number
  endedAt: number | null
  /** endedAt === null 时为运行中。 */
  running: boolean
  durationMs: number | null
  isError: boolean
  toolName?: string
  /** 详情面板：工具输入 / 用户消息原文（pretty 文本）。 */
  input?: string
  /** 详情面板：工具输出 / 助手完整文本。 */
  output?: string
  thinking?: string
  numTurns?: number
  stopReason?: string | null
}

/** 内部可变构建态；finalize 时收窄为 TraceRecord。 */
interface MutableRecord {
  id: string
  kind: TraceRecordKind
  turnNumber: number | null
  summary: string
  startedAt: number
  endedAt: number | null
  isError: boolean
  toolName?: string
  input?: string
  output?: string
  thinking?: string
  numTurns?: number
  stopReason?: string | null
}

function textFromContent(content: UserMessageDetail['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      const b = block as { type?: string; text?: string }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function firstLine(text: string, max = 240): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 工具输入的单行预览：优先取常见语义键，否则压平 JSON 前缀。 */
function toolInputPreview(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return firstLine(input)
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'query', 'url', 'pattern', 'skill', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return firstLine(value)
    }
  }
  return firstLine(prettyValue(input).replace(/\s+/g, ' '))
}

export function buildTraceRecords(events: readonly SdkEventEnvelope[]): TraceRecord[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)

  const records: MutableRecord[] = []
  const openTools = new Map<string, MutableRecord>()
  const openAssistants = new Map<string, MutableRecord>()
  let turnCounter = 0
  let runStartedAt: number | null = null

  const open = (record: Omit<MutableRecord, 'endedAt' | 'isError'> & Partial<Pick<MutableRecord, 'endedAt' | 'isError'>>) => {
    const mutable: MutableRecord = { endedAt: null, isError: false, ...record }
    records.push(mutable)
    return mutable
  }

  for (const event of sorted) {
    const detail = event.detail as SdkEventEnvelope['detail'] & { type?: string }
    switch (detail?.type) {
      case 'run.start': {
        runStartedAt = event.ts
        break
      }
      case 'user.message': {
        const { content } = detail as UserMessageDetail
        const text = textFromContent(content)
        open({
          id: String(event.seq),
          kind: 'user',
          turnNumber: null,
          summary: firstLine(text) || '(空消息)',
          startedAt: event.ts,
          input: text,
          endedAt: event.ts,
        })
        break
      }
      case 'turn.start': {
        turnCounter += 1
        break
      }
      case 'message.start': {
        if (event.turnId == null) break // user 消息前置的 message.start，由 user.message 分支处理
        // 同 turnId 的旧开记录先收口（防御异常序列）
        const stale = openAssistants.get(event.turnId)
        if (stale) {
          stale.endedAt = event.ts
          openAssistants.delete(event.turnId)
        }
        const record = open({
          id: String(event.seq),
          kind: 'assistant',
          turnNumber: turnCounter || null,
          summary: '…',
          startedAt: event.ts,
        })
        openAssistants.set(event.turnId, record)
        break
      }
      case 'message.update': {
        const openRecord = event.turnId == null ? undefined : openAssistants.get(event.turnId)
        if (!openRecord) break
        const { partial } = detail as MessageUpdateDetail
        const thinking = partial.thinking.trim()
        const text = partial.text.trim()
        if (partial.toolUses.length > 0 && !text) {
          // 流中 toolUse.name 恒为空（foldDelta 只折 input_json_delta），兜底防空白摘要
          openRecord.summary = partial.toolUses.map((t) => t.name).filter(Boolean).join('、') || '工具调用中'
        } else {
          openRecord.summary = firstLine(text) || (thinking ? `（思考中）${firstLine(thinking, 120)}` : '…')
        }
        openRecord.thinking = thinking || undefined
        break
      }
      case 'message.end': {
        const { message, error } = detail as MessageEndDetail
        const openRecord = event.turnId == null ? undefined : openAssistants.get(event.turnId)
        const text = textFromContent(message.content)
        if (openRecord) {
          openAssistants.delete(event.turnId!)
          openRecord.endedAt = event.ts
          openRecord.summary = firstLine(text) || '(无文本输出)'
          openRecord.output = text
          if (error) openRecord.isError = true
        } else {
          // 快照起点截断在流中途时的兜底：没有 start 也给出完整行
          open({
            id: String(event.seq),
            kind: 'assistant',
            turnNumber: turnCounter || null,
            summary: firstLine(text) || '(无文本输出)',
            startedAt: event.ts,
            output: text,
            endedAt: event.ts,
            isError: Boolean(error),
          })
        }
        break
      }
      case 'tool.start': {
        const { toolCallId, toolName, input } = detail as ToolStartDetail
        const staleTool = openTools.get(toolCallId)
        if (staleTool) {
          staleTool.endedAt = event.ts
          openTools.delete(toolCallId)
        }
        const record = open({
          id: String(event.seq),
          kind: 'tool',
          turnNumber: turnCounter || null,
          summary: toolInputPreview(input) ? `${toolName} ${toolInputPreview(input)}` : toolName,
          startedAt: event.ts,
          toolName,
          input: prettyValue(input),
        })
        openTools.set(toolCallId, record)
        break
      }
      case 'tool.end': {
        const { toolCallId, isError, output } = detail as ToolEndDetail
        const openRecord = openTools.get(toolCallId)
        if (openRecord) {
          openTools.delete(toolCallId)
          openRecord.endedAt = event.ts
          openRecord.output = output
          openRecord.isError = isError
        } else {
          open({
            id: String(event.seq),
            kind: 'tool',
            turnNumber: turnCounter || null,
            summary: '（缺失起始事件）',
            startedAt: event.ts,
            endedAt: event.ts,
            output,
            isError,
          })
        }
        break
      }
      case 'context.compaction': {
        const compaction = detail as ContextCompactionDetail
        if (compaction.phase !== 'completed') break
        open({
          id: String(event.seq),
          kind: 'compaction',
          turnNumber: turnCounter || null,
          summary: compaction.preTokens != null
            ? `上下文压缩 ${compaction.preTokens} → ${compaction.postTokens ?? '?'} tokens`
            : '上下文压缩完成',
          startedAt: event.ts,
          output: [compaction.result, compaction.outcome].filter(Boolean).join(' · ') || undefined,
          isError: compaction.isError === true,
          endedAt: event.ts,
        })
        break
      }
      case 'run.end': {
        const end = detail as RunEndDetail
        // 良性停止原因不上账本尾巴：成功运行发 end_turn，防御性兼容 completed
        const benignStop = end.stopReason == null || ['end_turn', 'completed'].includes(end.stopReason)
        open({
          id: String(event.seq),
          kind: 'run',
          turnNumber: null,
          summary: [
            end.isError ? '运行失败' : '运行结束',
            `${end.numTurns} 轮`,
            end.costUSD != null ? `$${end.costUSD.toFixed(4)}` : null,
            !benignStop && end.stopReason ? end.stopReason : null,
          ].filter(Boolean).join(' · '),
          startedAt: runStartedAt ?? event.ts,
          endedAt: event.ts,
          isError: end.isError,
          output: end.result ?? undefined,
          numTurns: end.numTurns,
          stopReason: end.stopReason,
        })
        runStartedAt = null
        break
      }
      default:
        break
    }
  }

  return records.map((record, i) => ({
    ...record,
    index: i + 1,
    running: record.endedAt === null,
    durationMs: record.endedAt != null ? Math.max(0, record.endedAt - record.startedAt) : null,
  }))
}
