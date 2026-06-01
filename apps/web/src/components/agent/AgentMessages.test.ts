import { describe, expect, test } from 'bun:test'
import type { RuntimeMessageView } from './runtime-message-view'
import type { AgentMessage } from '@lume/shared'
import {
  collectNewRuntimeMessageIds,
  getProgrammaticScrollHoldUntil,
  getLatestUserMessageKey,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldApplyThreadMessagesResult,
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

  test('keeps auto scroll enabled during programmatic scroll adjustments', () => {
    expect(shouldAutoScrollAfterUserScroll({
      currentScrollTop: 400,
      previousScrollTop: 460,
      nearBottom: false,
      programmatic: true,
    })).toBe(true)
  })

  test('keeps smooth programmatic scrolling active until it reaches the bottom or times out', () => {
    expect(getProgrammaticScrollHoldUntil({
      now: 100,
      behavior: 'smooth',
    })).toBe(Number.POSITIVE_INFINITY)
    expect(getProgrammaticScrollHoldUntil({
      now: 100,
      behavior: 'auto',
    })).toBe(280)
  })

  test('builds a stable key for the latest user message', () => {
    const messages: RuntimeMessageView[] = [
      {
        id: 'user:1',
        type: 'user',
        text: 'first',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'assistant:1',
        type: 'assistant',
        text: 'answer',
        thinking: '',
        toolCalls: [],
        blocks: [{ type: 'text', id: 'text:1', text: 'answer' }],
        status: 'completed',
      },
      {
        id: 'user:2',
        type: 'user',
        text: 'second',
        createdAt: '2026-05-01T00:01:00.000Z',
      },
    ]

    expect(getLatestUserMessageKey(messages)).toBe('2026-05-01T00:01:00.000Z:second')
  })

  test('rejects stale thread message fetch results after switching threads', () => {
    expect(shouldApplyThreadMessagesResult({
      requestedThreadId: 'thread-a',
      currentThreadId: 'thread-a',
      cancelled: false,
    })).toBe(true)
    expect(shouldApplyThreadMessagesResult({
      requestedThreadId: 'thread-a',
      currentThreadId: 'thread-b',
      cancelled: false,
    })).toBe(false)
    expect(shouldApplyThreadMessagesResult({
      requestedThreadId: 'thread-a',
      currentThreadId: 'thread-a',
      cancelled: true,
    })).toBe(false)
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

  test('uses visible user content when runtime event contains model-facing continuation text', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'message-continue',
      type: 'user',
      text: [
        '上一轮运行在进程退出前未正常完成。',
        '请继续完成上一轮未完成的原始任务。',
        '用户发送的继续指令：继续',
      ].join('\n\n'),
      createdAt: '2026-05-01T00:00:00.000Z',
      messageId: 'message-continue',
      versionGroupId: 'group-old',
      versionIndex: 1,
      versionCount: 1,
    }]
    const visibleThreadMessages = [{
      id: 'message-continue',
      role: 'user',
      content: '继续',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
      versionGroupId: 'group-visible',
      versionIndex: 2,
      versionCount: 3,
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)[0]).toEqual({
      id: 'message-continue',
      type: 'user',
      text: '继续',
      createdAt: '2026-05-01T00:00:00.000Z',
      messageId: 'message-continue',
      versionGroupId: 'group-visible',
      versionIndex: 2,
      versionCount: 3,
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
          providerOutputTokens: 17,
          contextUsage: {
            totalTokens: 120,
            contextWindow: 1000,
          },
          billingUsage: {
            inputTokens: 100,
            outputTokens: 17,
            cacheReadInputTokens: 12,
            cacheCreationInputTokens: 3,
            cachedTokens: 15,
          },
        },
      },
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)[0]).toMatchObject({
      tokenCount: 17,
      tokenCountSource: 'provider',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 17,
        cacheReadInputTokens: 12,
        cacheCreationInputTokens: 3,
        cachedTokens: 15,
        contextPercent: 12,
      },
    })
  })

  test('restores persisted assistant message id and completion time', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'assistant:1',
      type: 'assistant',
      text: '可分支输出',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 'text:1', text: '可分支输出' }],
      status: 'completed',
      tokenCount: 3,
    }]
    const visibleThreadMessages = [{
      id: 'assistant-message-1',
      role: 'assistant',
      content: '可分支输出',
      createdAt: Date.parse('2026-05-01T07:23:00.000Z'),
    }] as AgentMessage[]

    expect(reconcileUserMessageVersions(messages, visibleThreadMessages)[0]).toMatchObject({
      messageId: 'assistant-message-1',
      completedAt: '2026-05-01T07:23:00.000Z',
    })
  })
})

describe('projectVisibleThreadMessages', () => {
  test('restores persisted compaction status from assistant sdk messages when runtime events are empty', () => {
    const visibleThreadMessages = [{
      id: 'assistant-compact',
      role: 'assistant',
      content: '压缩后继续回答',
      createdAt: Date.parse('2026-05-01T07:23:00.000Z'),
      sdkMessages: [
        {
          type: 'system',
          subtype: 'context_compaction_started',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 900,
          },
        },
        {
          type: 'system',
          subtype: 'context_compaction_progress',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 900,
            stage: 'summarizing',
            progress: 45,
            message: '正在生成上下文摘要',
          },
        },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 900,
            post_tokens: 280,
          },
        },
      ],
    }] as AgentMessage[]

    expect(projectVisibleThreadMessages(visibleThreadMessages)).toEqual([
      {
        id: 'assistant-compact:0:context_compaction_started',
        type: 'system',
        variant: 'context_compaction',
        status: 'active',
        text: '正在自动压缩上下文',
        createdAt: '2026-05-01T07:23:00.000Z',
      },
      {
        id: 'assistant-compact:1:context_compaction_progress',
        type: 'system',
        variant: 'context_compaction',
        status: 'active',
        text: '正在生成上下文摘要',
        createdAt: '2026-05-01T07:23:00.000Z',
      },
      {
        id: 'assistant-compact:2:compact_boundary',
        type: 'system',
        variant: 'context_compaction',
        status: 'completed',
        text: '上下文已自动压缩',
        createdAt: '2026-05-01T07:23:00.000Z',
      },
      {
        id: 'assistant-compact',
        type: 'assistant',
        text: '压缩后继续回答',
        thinking: '',
        messageId: 'assistant-compact',
        completedAt: '2026-05-01T07:23:00.000Z',
        blocks: [{ type: 'text', id: 'text:assistant-compact', text: '压缩后继续回答' }],
        status: 'completed',
        toolCalls: [],
      },
    ])
  })

  test('projects forked transcript messages when runtime events are empty', () => {
    const visibleThreadMessages = [
      {
        id: 'user-1',
        role: 'user',
        content: '之前的问题',
        createdAt: Date.parse('2026-05-01T07:22:00.000Z'),
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '之前的回答',
        createdAt: Date.parse('2026-05-01T07:23:00.000Z'),
        metadata: {
          tokenUsage: {
            source: 'provider',
            scope: 'assistant_turn',
            providerOutputTokens: 42,
            contextUsage: {
              totalTokens: 420,
              contextWindow: 1000,
            },
            billingUsage: {
              inputTokens: 300,
              outputTokens: 42,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 5,
              cachedTokens: 25,
            },
          },
        },
      },
    ] as AgentMessage[]

    expect(projectVisibleThreadMessages(visibleThreadMessages)).toEqual([
      {
        id: 'user-1',
        type: 'user',
        text: '之前的问题',
        createdAt: '2026-05-01T07:22:00.000Z',
        messageId: 'user-1',
      },
      {
        id: 'assistant-1',
        type: 'assistant',
        text: '之前的回答',
        thinking: '',
        messageId: 'assistant-1',
        completedAt: '2026-05-01T07:23:00.000Z',
        blocks: [{ type: 'text', id: 'text:assistant-1', text: '之前的回答' }],
        status: 'completed',
        tokenCount: 42,
        tokenCountSource: 'provider',
        tokenUsage: {
          inputTokens: 300,
          outputTokens: 42,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
          cachedTokens: 25,
          contextTokens: 420,
          contextWindow: 1000,
          contextPercent: 42,
        },
        toolCalls: [],
      },
    ])
  })
})
