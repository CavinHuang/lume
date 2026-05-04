import { describe, expect, test } from 'bun:test'
import { reconcileUserMessageVersions, type RunEventMessageView } from './AgentMessages'
import type { AgentMessage } from '@lume/shared'

describe('reconcileUserMessageVersions', () => {
  test('keeps unmatched run-event turns stable while enriching matched user messages', () => {
    const messages: RunEventMessageView[] = [
      {
        id: 'user:1',
        type: 'user',
        text: '继续计划',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'assistant:1',
        type: 'assistant',
        text: '继续输出',
        thinking: '',
        toolCalls: [],
        blocks: [{ type: 'text', id: 'text:1', text: '继续输出' }],
      },
      {
        id: 'user:2',
        type: 'user',
        text: 'hello',
        createdAt: '2026-05-01T00:01:00.000Z',
      },
    ]
    const visibleThreadMessages = [{
      id: 'message-2',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:01:00.000Z'),
      versionGroupId: 'group-2',
      versionIndex: 1,
      versionCount: 1,
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)).toEqual([
      messages[0],
      messages[1],
      {
        ...messages[2],
        id: 'message-2',
        messageId: 'message-2',
        versionGroupId: 'group-2',
        versionIndex: 1,
        versionCount: 1,
      },
    ])
  })
})
