import { describe, expect, test } from 'bun:test'
import type { AgentFollowUpMode, AgentSendInput, AgentRetryQueuedMessageInput } from '../agent'

describe('AgentFollowUpMode 类型契约', () => {
  test('AgentFollowUpMode 仅允许 steer | queue | interrupt', () => {
    const modes: AgentFollowUpMode[] = ['steer', 'queue', 'interrupt']
    expect(modes).toHaveLength(3)
  })

  test('AgentSendInput.followUpQueueMode 可选且接受三态', () => {
    const input: AgentSendInput = {
      threadId: 't1',
      userMessage: 'hi',
      followUpQueueMode: 'steer',
    }
    expect(input.followUpQueueMode).toBe('steer')
  })

  test('AgentRetryQueuedMessageInput 形状稳定', () => {
    const req: AgentRetryQueuedMessageInput = {
      threadId: 't1',
      queuedMessageId: 'q1',
      expectedRevision: 3,
      queueOperationId: 'op-1',
    }
    expect(req.queuedMessageId).toBe('q1')
  })
})
