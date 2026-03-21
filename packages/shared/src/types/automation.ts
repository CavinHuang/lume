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
  /** 执行结果回写会话 ID（可选） */
  sessionId?: string
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
  sessionId?: string
  schedule: AutomationSchedule
  prompt: string
}

/** 更新任务输入 */
export interface AutomationUpdateJobInput {
  id: string
  name?: string
  enabled?: boolean
  workspaceId?: string
  sessionId?: string
  schedule?: AutomationSchedule
  prompt?: string
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
  sessionId?: string
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
  /** 获取任务列表 */
  LIST_JOBS: 'automation:list-jobs',
  /** 创建任务 */
  CREATE_JOB: 'automation:create-job',
  /** 更新任务 */
  UPDATE_JOB: 'automation:update-job',
  /** 删除任务 */
  DELETE_JOB: 'automation:delete-job',
  /** 获取运行记录 */
  LIST_RUNS: 'automation:list-runs',
  /** 立即执行任务 */
  RUN_NOW: 'automation:run-now'
} as const
