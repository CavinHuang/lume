import type { AgentMessageAttachmentInput, ImPeerKind, ImProvider, LumeRuntimeEvent } from '@lume/shared'

export interface RuntimeToolCallView {
  id: string
  toolName: string
  input: unknown
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  isError?: boolean
  permissionState?: 'timeout'
  subagentRunId?: string
  subagentStatus?: 'running' | 'completed' | 'errored'
  startedAt?: string
  durationMs?: number
}

export type TaskProgressViewEvent = Extract<LumeRuntimeEvent, { type: 'task.progress' }>
export type MemoryContextUsedViewEvent = Extract<LumeRuntimeEvent, { type: 'memory.context.used' }>
export type ContextCompactionViewEvent = Extract<LumeRuntimeEvent, { type: 'context.compaction.started' | 'context.compaction.progress' | 'context.compaction.completed' }>
export type PlanPreviewView = Pick<
  Extract<LumeRuntimeEvent, { type: 'plan.preview' }>,
  'contractId' | 'title' | 'summary' | 'markdown' | 'planFilePath' | 'planVerified' | 'stepCount'
>

export interface TodoBlockData {
  todos: { content: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed' }[]
  currentActiveForm: string | null
}

export type RuntimeAssistantBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool_call'; id: string; toolCall: RuntimeToolCallView }
  | { type: 'task_progress'; id: string; event: TaskProgressViewEvent }
  | { type: 'memory_context_used'; id: string; event: MemoryContextUsedViewEvent }
  | { type: 'plan_preview'; id: string; preview: PlanPreviewView }
  | { type: 'todo_update'; id: string; data: TodoBlockData }

export interface RuntimeAssistantTokenUsageView {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cachedTokens?: number
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}

export interface RuntimeAssistantMessageView {
  id: string
  type: 'assistant'
  text: string
  thinking: string
  messageId?: string
  completedAt?: string
  blocks: RuntimeAssistantBlock[]
  status: 'streaming' | 'completed' | 'failed'
  error?: string
  tokenCount?: number
  tokenCountSource?: 'provider'
  tokenUsage?: RuntimeAssistantTokenUsageView
  imDelivery?: {
    status: 'pending' | 'sent' | 'failed'
    provider: ImProvider
    peerKind: ImPeerKind
    peerId: string
    error?: string
  }
  toolCalls: RuntimeToolCallView[]
}

export interface RuntimeUserMessageView {
  id: string
  type: 'user'
  text: string
  createdAt: string
  attachments?: AgentMessageAttachmentInput[]
  messageId?: string
  versionGroupId?: string
  versionIndex?: number
  versionCount?: number
}

export interface RuntimeSystemMessageView {
  id: string
  type: 'system'
  variant: 'context_compaction'
  status: 'active' | 'completed'
  text: string
  summary?: string
  createdAt: string
}

export type RuntimeMessageView = RuntimeUserMessageView | RuntimeAssistantMessageView | RuntimeSystemMessageView
