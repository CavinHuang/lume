import { describe, expect, test } from 'bun:test'
import type { AgentPendingInteractiveState, AutomationJob } from '@lume/shared'
import { buildAutomationApprovalSummaries } from './automation-approval-state'

describe('automation approval state', () => {
  test('extracts automation approvals and joins known job names', () => {
    const jobs: AutomationJob[] = [{
      id: 'job-1',
      name: 'Nightly report',
      description: 'report',
      prompt: 'run report',
      enabled: true,
      schedule: { type: 'manual' },
      triggerModes: ['manual'],
      createdAt: 1,
      updatedAt: 1,
    }]
    const pending: Record<string, AgentPendingInteractiveState> = {
      'thread-1': {
        threadId: 'thread-1',
        toolPermissions: [{
          threadId: 'thread-1',
          requestId: 'req-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          risk: 'high',
          reason: 'needs approval',
          input: { command: 'deploy' },
          interruptionType: 'automation_approval',
          automationJobId: 'job-1',
        }, {
          threadId: 'thread-1',
          requestId: 'req-2',
          toolUseId: 'tool-2',
          toolName: 'Read',
          risk: 'low',
          reason: 'ordinary approval',
          input: {},
        }],
      },
    }

    expect(buildAutomationApprovalSummaries(pending, jobs)).toEqual([{
      threadId: 'thread-1',
      requestId: 'req-1',
      toolName: 'Bash',
      reason: 'needs approval',
      risk: 'high',
      jobId: 'job-1',
      jobName: 'Nightly report',
    }])
  })
})

