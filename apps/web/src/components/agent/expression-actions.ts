import { stripAfterglowLines, type AgentSendInput } from '@lume/shared'

export type ExpressionActionId = 'diagram' | 'condense' | 'checklist'

export interface ExpressionAction {
  id: ExpressionActionId
  label: string
  prompt: string
}

const ACTIONS: Record<ExpressionActionId, ExpressionAction> = {
  diagram: {
    id: 'diagram',
    label: '画成图',
    prompt: '请把上一条回答改写为一张清晰的 Mermaid 图，并保留不超过三句必要结论，不要重复完整原文。',
  },
  condense: {
    id: 'condense',
    label: '压缩成三点',
    prompt: '请把上一条回答压缩为三个最重要的要点，保留结论、关键依据和下一步。',
  },
  checklist: {
    id: 'checklist',
    label: '整理成清单',
    prompt: '请把上一条回答整理为可执行清单，按优先级排列，并明确每一步的完成标准。',
  },
}

const STRUCTURE_SIGNAL = /流程|步骤|阶段|架构|关系|链路|时序|分支|依赖|流转/u
const ACTION_SIGNAL = /实施|执行|落地|下一步|计划/u
const MERMAID_FENCE = /```mermaid(?:\s|$)/iu
const MARKDOWN_CHECKLIST = /^\s*[-*]\s+\[[ xX]\]/mu

export function deriveExpressionActions(text: string, isStreaming = false): ExpressionAction[] {
  const content = stripAfterglowLines(text).trim()
  if (isStreaming || content.length < 200) return []

  const actions: ExpressionAction[] = []
  if (STRUCTURE_SIGNAL.test(content) && !MERMAID_FENCE.test(content)) {
    actions.push(ACTIONS.diagram)
  }

  const headingCount = content.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).length
  const paragraphCount = content.split(/\r?\n\s*\r?\n/).filter((part) => part.trim()).length
  if (content.length > 600 || headingCount >= 5 || paragraphCount >= 5) {
    actions.push(ACTIONS.condense)
  }

  if (ACTION_SIGNAL.test(content) && !MARKDOWN_CHECKLIST.test(content)) {
    actions.push(ACTIONS.checklist)
  }

  return actions.slice(0, 2)
}

export function buildExpressionActionSendInput(
  threadId: string,
  sourceMessageId: string | undefined,
  action: ExpressionAction,
): AgentSendInput {
  return {
    threadId,
    userMessage: action.prompt,
    messageMetadata: {
      expressionActionId: action.id,
      ...(sourceMessageId ? { expressionActionSourceMessageId: sourceMessageId } : {}),
    },
  }
}

interface ExpressionActionMessageCandidate {
  type: string
  status?: string
}

export function getExpressionActionMessageIndex(
  messages: ExpressionActionMessageCandidate[],
  isStreaming: boolean,
): number {
  if (isStreaming || messages.length === 0) return -1
  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]
  return lastMessage?.type === 'assistant' && lastMessage.status === 'completed' ? lastIndex : -1
}
