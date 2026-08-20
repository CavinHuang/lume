import { atom } from 'jotai'
import type { AutomationJob, AutomationRun } from '@lume/shared'

export const automationJobsAtom = atom<AutomationJob[]>([])
export const automationRunsAtom = atom<AutomationRun[]>([])

/**
 * 跨视图"预选自动化任务"通道。
 * 外部视图（如日程）写入要跳转的 jobId；AutomationManagementView 挂载时消费并清空。
 */
export const pendingAutomationJobIdAtom = atom<string | null>(null)
