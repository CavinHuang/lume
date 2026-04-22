import { sidecarCall } from './system'
import type { AutomationJob, AutomationRun } from '@lume/shared'

export const listAutomationJobs = () =>
  sidecarCall<AutomationJob[]>('automation:list-jobs')

export const createAutomationJob = (input: {
  name: string
  prompt: string
  workspaceId?: string
  schedule: {
    type: string
    cronExpr?: string
    runAt?: number
    intervalMs?: number
  }
}) => sidecarCall<AutomationJob>('automation:create-job', input)

export const updateAutomationJob = (input: {
  id: string
  name?: string
  prompt?: string
  enabled?: boolean
  workspaceId?: string
  schedule?: {
    type: string
    cronExpr?: string
    runAt?: number
    intervalMs?: number
  }
}) => sidecarCall<AutomationJob>('automation:update-job', input)

export const deleteAutomationJob = (id: string) =>
  sidecarCall<{ ok: true }>('automation:delete-job', { id })

export const toggleAutomationJob = (id: string) =>
  sidecarCall<AutomationJob>('automation:toggle-job', { id })

export const runAutomationJobNow = (id: string) =>
  sidecarCall<AutomationRun>('automation:run-now', { id })

export const listAutomationRuns = (input?: { jobId?: string; limit?: number }) =>
  sidecarCall<AutomationRun[]>('automation:list-runs', input ?? {})
