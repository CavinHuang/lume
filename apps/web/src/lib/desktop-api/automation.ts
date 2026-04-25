import { sidecarCall } from './system'
import type {
  AutomationCreateJobInput,
  AutomationJob,
  AutomationRun,
  AutomationUpdateJobInput,
} from '@lume/shared'

export const listAutomationJobs = () =>
  sidecarCall<AutomationJob[]>('automation:list-jobs')

export const createAutomationJob = (input: AutomationCreateJobInput) =>
  sidecarCall<AutomationJob>('automation:create-job', input)

export const updateAutomationJob = (input: AutomationUpdateJobInput) =>
  sidecarCall<AutomationJob>('automation:update-job', input)

export const deleteAutomationJob = (id: string) =>
  sidecarCall<{ ok: true }>('automation:delete-job', { id })

export const toggleAutomationJob = (id: string) =>
  sidecarCall<AutomationJob>('automation:toggle-job', { id })

export const runAutomationJobNow = (id: string) =>
  sidecarCall<AutomationRun>('automation:run-now', { id })

export const listAutomationRuns = (input?: { jobId?: string; limit?: number }) =>
  sidecarCall<AutomationRun[]>('automation:list-runs', input ?? {})
