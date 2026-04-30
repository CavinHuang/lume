import type {
  AgentPendingInteractiveState,
  AgentToolPermissionRiskLevel,
  AutomationJob,
} from '@lume/shared'

export interface AutomationApprovalSummary {
  threadId: string
  requestId: string
  toolName: string
  reason: string
  risk: AgentToolPermissionRiskLevel
  jobId?: string
  jobName?: string
}

export function buildAutomationApprovalSummaries(
  pending: Record<string, AgentPendingInteractiveState>,
  jobs: AutomationJob[],
): AutomationApprovalSummary[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  return Object.values(pending)
    .flatMap((state) => (
      (state.toolPermissions ?? [])
        .filter((request) => request.interruptionType === 'automation_approval')
        .map((request) => {
          const job = request.automationJobId ? jobsById.get(request.automationJobId) : undefined
          return {
            threadId: state.threadId,
            requestId: request.requestId,
            toolName: request.toolName,
            reason: request.reason,
            risk: request.risk,
            ...(request.automationJobId ? { jobId: request.automationJobId } : {}),
            ...(job ? { jobName: job.name } : {}),
          }
        })
    ))
}

