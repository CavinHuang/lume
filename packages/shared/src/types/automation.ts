/**
 * Automation 相关类型定义
 *
 * 包含定时任务（Job）配置与基础 IPC 通道常量。
 */

/** 调度类型 */
export type AutomationScheduleType = 'cron' | 'once' | 'interval' | 'manual'
export type AutomationMisfirePolicy = 'run_latest' | 'skip'

/** 自动化任务触发入口 */
export type AutomationTriggerMode = 'manual' | 'schedule' | 'webhook' | 'chat'

/** 自动化任务来源 */
export type AutomationJobSource = 'manual' | 'system'

/** 系统自动化动作标识 */
export type AutomationSystemAction = 'routine' | 'memory_distill_workspace'
export interface AutomationJobProvenance {
  kind: 'routine_todo_review'
  routineId: string
  activityId: string
}

/** 任务调度配置 */
export interface AutomationSchedule {
  /** 调度类型 */
  type: AutomationScheduleType
  /** cron 表达式（type=cron） */
  cronExpr?: string
  /** 指定执行时间戳（毫秒，type=once） */
  runAt?: number
  /** 固定间隔毫秒（type=interval） */
  intervalMs?: number
  /** 可选时区（仅 cron 使用） */
  timezone?: string
  /** 应用停机错过触发时的处理策略，默认仅补跑最新一次。 */
  misfirePolicy?: AutomationMisfirePolicy
}

/** 自动化任务定义 */
export interface AutomationJob {
  /** 任务 ID */
  id: string
  /** 任务名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /** 禁用原因（项目移除等系统操作写入） */
  disabledReason?: string
  /** 所属工作区（可选） */
  workspaceId?: string
  /** 调度配置 */
  schedule: AutomationSchedule
  /** 可触发任务的入口，用于管理页展示和未来能力扩展 */
  triggerModes?: AutomationTriggerMode[]
  /** 创建来源：用户手动创建或系统自动创建 */
  source?: AutomationJobSource
  /** 系统自动创建任务的动作标识 */
  systemAction?: AutomationSystemAction
  /** Sidecar-owned immutable provenance for privileged system jobs. */
  provenance?: AutomationJobProvenance
  /** 简短说明 */
  description?: string
  /** 默认模型展示值 */
  defaultModel?: string
  /** 推理强度（off / low / medium / high / max） */
  thinkingLevel?: string
  /** 任务可用工具与资源标识 */
  toolResourceIds?: string[]
  /** 执行提示词（后续可扩展为 workflow） */
  prompt: string
  /** 执行结果回写线程 ID（可选） */
  threadId?: string
  /** 最近一次实际触发时间戳 */
  lastRunAt?: number
  /** interval 的稳定计划锚点。 */
  scheduleAnchorAt?: number
  /** 下一次预计触发时间戳；手动或禁用任务为 null */
  nextRunAt?: number | null
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/** 自动化任务索引 */
export interface AutomationJobsIndex {
  version: number
  jobs: AutomationJob[]
}

/** 创建任务输入 */
export interface AutomationCreateJobInput {
  name: string
  enabled?: boolean
  disabledReason?: string
  workspaceId?: string
  threadId?: string
  schedule: AutomationSchedule
  triggerModes?: AutomationTriggerMode[]
  source?: AutomationJobSource
  systemAction?: AutomationSystemAction
  description?: string
  defaultModel?: string
  thinkingLevel?: string
  toolResourceIds?: string[]
  prompt: string
}

/** 更新任务输入 */
export interface AutomationUpdateJobInput {
  id: string
  name?: string
  enabled?: boolean
  disabledReason?: string
  workspaceId?: string
  threadId?: string
  schedule?: AutomationSchedule
  triggerModes?: AutomationTriggerMode[]
  source?: AutomationJobSource
  systemAction?: AutomationSystemAction
  description?: string
  defaultModel?: string
  thinkingLevel?: string
  toolResourceIds?: string[]
  prompt?: string
}

/** 删除任务输入 */
export interface AutomationDeleteJobInput {
  id: string
}

/** 运行触发来源 */
export type AutomationRunTrigger = 'schedule' | 'manual'

/** 运行状态 */
export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'waiting_for_user'
  | 'waiting_for_approval'
  | 'interrupted'
  | 'cancelled'

/** 自动化任务运行记录 */
export interface AutomationRun {
  id: string
  jobId: string
  jobName: string
  threadId?: string
  trigger: AutomationRunTrigger
  status: AutomationRunStatus
  message: string
  startedAt: number
  finishedAt: number
  /** 运行确实发生但 runs.jsonl 落盘失败（盘满/占用）：仅内存补显，重启后消失（#615 UX review round7） */
  persistenceLost?: boolean
}

/** 查询运行记录输入 */
export interface AutomationListRunsInput {
  jobId?: string
  limit?: number
}

/** 立即执行输入 */
export interface AutomationRunNowInput {
  id: string
}

/** Automation IPC 通道 */
export const AUTOMATION_IPC_CHANNELS = {
  LIST_JOBS: 'automation:list-jobs',
  CREATE_JOB: 'automation:create-job',
  UPDATE_JOB: 'automation:update-job',
  DELETE_JOB: 'automation:delete-job',
  TOGGLE_JOB: 'automation:toggle-job',
  LIST_RUNS: 'automation:list-runs',
  RUN_NOW: 'automation:run-now',
  RUN_COMPLETED: 'automation:run-completed'
} as const
