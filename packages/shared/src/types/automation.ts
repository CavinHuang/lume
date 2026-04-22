/**
 * Automation 相关类型定义
 *
 * 包含定时任务（Job）配置与基础 IPC 通道常量。
 */

/** 调度类型 */
export type AutomationScheduleType = 'cron' | 'once' | 'interval'

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
}

/** 自动化任务定义 */
export type AutomationSystemAction = 'memory_distill_workspace'

/** 自动化任务定义 */
export interface AutomationJob {
  /** 任务 ID */
  id: string
  /** 任务名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /** 所属工作区（可选） */
  workspaceId?: string
  /** 调度配置 */
  schedule: AutomationSchedule
  /** 执行提示词（后续可扩展为 workflow） */
  prompt: string
  /** 内置系统动作（可选）。存在时优先执行系统动作，而不是发送 Agent prompt。 */
  systemAction?: AutomationSystemAction
  /** 执行结果回写线程 ID（可选） */
  threadId?: string
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
  workspaceId?: string
  threadId?: string
  schedule: AutomationSchedule
  prompt: string
  systemAction?: AutomationSystemAction
}

/** 更新任务输入 */
export interface AutomationUpdateJobInput {
  id: string
  name?: string
  enabled?: boolean
  workspaceId?: string
  threadId?: string
  schedule?: AutomationSchedule
  prompt?: string
  systemAction?: AutomationSystemAction
}

/** 删除任务输入 */
export interface AutomationDeleteJobInput {
  id: string
}

/** 运行触发来源 */
export type AutomationRunTrigger = 'schedule' | 'manual'

/** 运行状态 */
export type AutomationRunStatus = 'success' | 'failed' | 'skipped'

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
