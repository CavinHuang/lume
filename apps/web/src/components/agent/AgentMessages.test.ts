import { describe, expect, test } from 'bun:test'
import { reconcileUserMessageVersions } from './AgentMessages'
import type { RuntimeMessageView } from './runtime-message-view'
import type { AgentMessage } from '@lume/shared'

describe('reconcileUserMessageVersions', () => {
  test('keeps unmatched runtime turns stable while enriching matched user messages', () => {
    const messages: RuntimeMessageView[] = [
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

  test('restores persisted user message attachments from visible metadata', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'user:1',
      type: 'user',
      text: '总结附件',
      createdAt: '2026-05-01T00:00:00.000Z',
    }]
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: '总结附件',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
      metadata: {
        messageAttachments: [{
          id: 'att-1',
          filename: 'brief.md',
          mediaType: 'text/markdown',
          size: 2048,
          threadPath: 'docs/brief.md',
        }],
      },
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)[0]).toMatchObject({
      attachments: [{
        id: 'att-1',
        filename: 'brief.md',
        mediaType: 'text/markdown',
        size: 2048,
        threadPath: 'docs/brief.md',
      }],
    })
  })
})
