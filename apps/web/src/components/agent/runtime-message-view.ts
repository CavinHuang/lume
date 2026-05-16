import type { LumeRuntimeEvent } from '@lume/shared'

export interface RuntimeToolCallView {
  id: string
  toolName: string
  input: unknown
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  isError?: boolean
}

export type TaskProgressViewEvent = Extract<LumeRuntimeEvent, { type: 'task.progress' }>
export type PlanPreviewView = Pick<
  Extract<LumeRuntimeEvent, { type: 'plan.preview' }>,
  'contractId' | 'title' | 'summary' | 'markdown' | 'planFilePath' | 'planVerified' | 'stepCount'
>

export type RuntimeAssistantBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool_call'; id: string; toolCall: RuntimeToolCallView }
  | { type: 'task_progress'; id: string; event: TaskProgressViewEvent }
  | { type: 'plan_preview'; id: string; preview: PlanPreviewView }

export interface RuntimeAssistantMessageView {
  id: string
  type: 'assistant'
  text: string
  thinking: string
  blocks: RuntimeAssistantBlock[]
  status: 'streaming' | 'completed' | 'failed'
  error?: string
  toolCalls: RuntimeToolCallView[]
}

export interface RuntimeUserMessageView {
  id: string
  type: 'user'
  text: string
  createdAt: string
  messageId?: string
  versionGroupId?: string
  versionIndex?: number
  versionCount?: number
}

export type RuntimeMessageView = RuntimeUserMessageView | RuntimeAssistantMessageView
