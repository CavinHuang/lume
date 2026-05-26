import { describe, expect, test } from 'bun:test'
import type { RuntimeMessageView } from './runtime-message-view'
import type { AgentMessage } from '@lume/shared'
import {
  collectNewRuntimeMessageIds,
  getPreservedScrollTopAfterResize,
  isNearScrollBottom,
  reconcileUserMessageVersions,
  shouldAutoScrollAfterUserScroll,
} from './agent-message-state'

describe('collectNewRuntimeMessageIds', () => {
  test('does not mark streamed content updates as new messages', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'assistant:run-1',
      type: 'assistant',
      text: '继续输出更多内容',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 'text:0', text: '继续输出更多内容' }],
      status: 'streaming',
    }]

    expect(collectNewRuntimeMessageIds(new Set(['assistant:run-1']), messages)).toEqual(new Set())
  })

  test('marks only newly inserted runtime messages', () => {
    const messages: RuntimeMessageView[] = [
      {
        id: 'user:1',
        type: 'user',
        text: '写一篇文章',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'assistant:run-1',
        type: 'assistant',
        text: '',
        thinking: '',
        toolCalls: [],
        blocks: [],
        status: 'streaming',
      },
    ]

    expect(collectNewRuntimeMessageIds(new Set(['user:1']), messages)).toEqual(new Set(['assistant:run-1']))
  })
})

describe('agent message scroll helpers', () => {
  test('treats the viewport as at bottom within the scroll threshold', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 620, clientHeight: 320 })).toBe(true)
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 320 })).toBe(false)
  })

  test('disables auto scroll when the user scrolls upward', () => {
    expect(shouldAutoScrollAfterUserScroll({
      currentScrollTop: 400,
      previousScrollTop: 460,
      nearBottom: true,
    })).toBe(false)
  })

  test('keeps auto scroll only while scrolling downward near the bottom', () => {
    expect(shouldAutoScrollAfterUserScroll({
      currentScrollTop: 460,
      previousScrollTop: 400,
      nearBottom: true,
    })).toBe(true)
    expect(shouldAutoScrollAfterUserScroll({
      currentScrollTop: 460,
      previousScrollTop: 400,
      nearBottom: false,
    })).toBe(false)
  })

  test('preserves viewport position when historical content changes height', () => {
    expect(getPreservedScrollTopAfterResize({
      currentScrollTop: 300,
      previousScrollHeight: 1200,
      nextScrollHeight: 1360,
    })).toBe(460)
  })

})

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

  test('restores provider assistant token usage from visible metadata', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'assistant:1',
      type: 'assistant',
      text: '真实输出',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 'text:1', text: '真实输出' }],
      status: 'completed',
      tokenCount: 3,
    }]
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'assistant',
      content: '真实输出',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
      metadata: {
        tokenUsage: {
          source: 'provider',
          scope: 'assistant_turn',
          outputTokens: 17,
        },
      },
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)[0]).toMatchObject({
      tokenCount: 17,
      tokenCountSource: 'provider',
    })
  })
})
