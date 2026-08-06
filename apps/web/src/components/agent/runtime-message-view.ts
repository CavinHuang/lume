import type { AgentCapabilityReferenceView, AgentDiffCommentAttachment, AgentMessageAttachmentInput, AgentUserMessagePart, FileReferenceBinding, FileReferenceProtocolVersion, ImPeerKind, ImProvider, LumeRuntimeEvent, RuntimeCodingReport, ToolExecutionMetadata } from '@lume/shared'
import type { MemoryCenterDeepLink } from '@/components/memory/memory-center-state'

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
  riskLevel?: 'low' | 'medium' | 'high'
  execution?: ToolExecutionMetadata
  resultRef?: ToolExecutionMetadata['resultRef']
}

export type TaskProgressViewEvent = Extract<LumeRuntimeEvent, { type: 'task.progress' }>
export type MemoryContextUsedViewEvent = Extract<LumeRuntimeEvent, { type: 'memory.context.used' }>
export type AdvisorReviewedViewEvent = Extract<LumeRuntimeEvent, { type: 'advisor.reviewed' }>
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
  | { type: 'advisor_review'; id: string; event: AdvisorReviewedViewEvent }
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
  fileReferenceBinding?: FileReferenceBinding
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion
  completedAt?: string
  blocks: RuntimeAssistantBlock[]
  status: 'streaming' | 'completed' | 'failed'
  error?: string
  retry?: {
    phase: 'waiting' | 'retrying'
    attempt: number
    maxRetries: number
    retryDelayMs: number
  }
  tokenCount?: number
  tokenCountSource?: 'provider'
  tokenUsage?: RuntimeAssistantTokenUsageView
  codingReport?: RuntimeCodingReport
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
  commentAttachments?: AgentDiffCommentAttachment[]
  messageParts?: AgentUserMessagePart[]
  capabilityReferences?: AgentCapabilityReferenceView[]
  messageId?: string
  versionGroupId?: string
  versionIndex?: number
  versionCount?: number
}

export type RuntimeSystemMessageView =
  | {
      id: string
      type: 'system'
      variant: 'context_compaction'
      status: 'active' | 'completed'
      text: string
      summary?: string
      createdAt: string
    }
  | {
      id: string
      type: 'system'
      variant: 'memory_saved'
      status: 'completed'
      text: string
      createdAt: string
      workspaceSlug: string
      details: Extract<LumeRuntimeEvent, { type: 'memory.changed' }>['details']
      target: MemoryCenterDeepLink
    }
  | {
      id: string
      type: 'system'
      variant: 'memory_job'
      status: 'active' | 'completed'
      text: string
      createdAt: string
      target: MemoryCenterDeepLink
    }

export type RuntimeMessageView = RuntimeUserMessageView | RuntimeAssistantMessageView | RuntimeSystemMessageView
