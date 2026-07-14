import { describe, expect, test } from 'bun:test'
import type { RuntimeMessageView, RuntimeAssistantMessageView, RuntimeAssistantBlock } from './runtime-message-view'
import type { AgentMessage } from '@lume/shared'
import { areRuntimeEventContentBlockPropsEqual } from './RuntimeEventContentBlock'
import {
  collectNewRuntimeMessageIds,
  collectConversationMinimapItems,
  getProgrammaticScrollHoldUntil,
  getLatestUserMessageKey,
  isNearScrollBottom,
  projectVisibleThreadMessages,
  reconcileUserMessageVersions,
  shouldApplyThreadMessagesResult,
  shouldAutoScrollAfterUserScroll,
  stabilizeRuntimeMessages,
  type ReconcileCache,
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

describe('collectConversationMinimapItems', () => {
  test('builds dense minimap anchors from user turns with assistant previews', () => {
    const messages: RuntimeMessageView[] = [
      {
        id: 'user:1',
        type: 'user',
        text: 'first question',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'assistant:1',
        type: 'assistant',
        text: 'first answer',
        thinking: '',
        toolCalls: [],
        blocks: [{ type: 'text', id: 'text:1', text: 'first answer' }],
        status: 'completed',
      },
      {
        id: 'assistant:2',
        type: 'assistant',
        text: 'follow-up detail',
        thinking: '',
        toolCalls: [],
        blocks: [{ type: 'text', id: 'text:2', text: 'follow-up detail' }],
        status: 'completed',
      },
      {
        id: 'system:1',
        type: 'system',
        variant: 'context_compaction',
        status: 'active',
        text: '压缩中',
        createdAt: '2026-05-01T00:00:01.000Z',
      },
      {
        id: 'user:2',
        type: 'user',
        text: 'second question',
        createdAt: '2026-05-01T00:00:02.000Z',
      },
      {
        id: 'assistant:3',
        type: 'assistant',
        text: 'second answer',
        thinking: '',
        toolCalls: [],
        blocks: [{ type: 'text', id: 'text:3', text: 'second answer' }],
        status: 'completed',
      },
    ]

    expect(collectConversationMinimapItems(messages)).toEqual([
      {
        id: 'user:1',
        title: 'first question',
        preview: 'first answer\n\nfollow-up detail',
      },
      {
        id: 'user:2',
        title: 'second question',
        preview: 'second answer',
      },
    ])
  })
})

describe('agent message scroll helpers', () => {
  test('treats the viewport as at bottom within the scroll threshold', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 620, clientHeight: 320 })).toBe(true)
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 320 })).toBe(false)
  })

  test('disables auto scroll when the user scrolls upward away from the bottom', () => {
    expect(shouldAutoScrollAfterUserScroll({
      nearBottom: false,
    })).toBe(false)
  })

  test('keeps auto scroll when scrollTop shrinks due to content collapse while at the bottom', () => {
    // 上方内容（思考过程/工具结果）折叠 → scrollHeight 减小 → 浏览器把 scrollTop
    // clamp 到新的 max。此刻 distToBottom=0、仍在最底部，不应被误判为“用户向上滚”
    // 而关闭粘底（数值取自真实复现日志）。
    expect(shouldAutoScrollAfterUserScroll({
      nearBottom: true,
    })).toBe(true)
  })

  test('keeps auto scroll during sub-pixel jitter at the bottom', () => {
    expect(shouldAutoScrollAfterUserScroll({
      nearBottom: true,
    })).toBe(true)
  })

  test('keeps auto scroll only while scrolling downward near the bottom', () => {
    expect(shouldAutoScrollAfterUserScroll({
      nearBottom: true,
    })).toBe(true)
    expect(shouldAutoScrollAfterUserScroll({
      nearBottom: false,
    })).toBe(false)
  })

  test('keeps auto scroll enabled during programmatic scroll adjustments', () => {
    expect(shouldAutoScrollAfterUserScroll({
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

  test('reuses the previous result when projected and visible references are unchanged', () => {
    const messages: RuntimeMessageView[] = [{
      id: 'user:1',
      type: 'user',
      text: 'hello',
      createdAt: '2026-05-01T00:00:00.000Z',
    }]
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()

    const first = reconcileUserMessageVersions(messages, visibleThreadMessages, cache)
    // 第二次：相同的 messages 引用 + 相同 visible 引用 → 复用上次 result（引用稳定）
    const second = reconcileUserMessageVersions(messages, visibleThreadMessages, cache)
    expect(second[0]).toBe(first[0])
  })

  test('re-reconciles when the projected message reference changes', () => {
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()

    const first = reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    // projected 引用变（新对象，内容相同）→ miss → 重新 spread 新 result
    const second = reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    expect(second[0]).not.toBe(first[0])
  })

  test('drops cache entries for removed messages', () => {
    const visibleThreadMessages = [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: Date.parse('2026-05-01T00:00:00.000Z'),
    }] as AgentMessage[]
    const cache: ReconcileCache = new Map()
    reconcileUserMessageVersions(
      [{ id: 'user:1', type: 'user', text: 'hello', createdAt: '2026-05-01T00:00:00.000Z' }],
      visibleThreadMessages,
      cache,
    )
    expect(cache.has('user:1')).toBe(true)
    reconcileUserMessageVersions([], visibleThreadMessages, cache)
    expect(cache.has('user:1')).toBe(false)
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

describe('areRuntimeEventContentBlockPropsEqual', () => {
  const baseAssistantMessage: RuntimeAssistantMessageView = {
    id: 'assistant:run-1',
    type: 'assistant',
    text: '你好',
    thinking: '',
    toolCalls: [],
    blocks: [{ type: 'text', id: 'text:0', text: '你好' }],
    status: 'completed',
  }

  test('treats the same message reference as equal', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(true)
  })

  test('treats a different message reference as not equal even when content matches', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = {
      message: { ...baseAssistantMessage, blocks: [{ ...baseAssistantMessage.blocks[0] }] },
      threadId: 't1',
      streaming: false,
      animate: false,
    }
    expect(next.message).not.toBe(prev.message)
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })

  test('detects assistant text change', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = {
      message: { ...baseAssistantMessage, text: '变了', blocks: [{ type: 'text', id: 'text:0', text: '变了' }] },
      threadId: 't1',
      streaming: false,
      animate: false,
    }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })

  test('detects streaming prop change', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = { message: baseAssistantMessage, threadId: 't1', streaming: true, animate: false }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })

  test('detects animate prop change', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: false }
    const next = { message: baseAssistantMessage, threadId: 't1', streaming: false, animate: true }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })

  test('detects assistant avatar visibility change', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', showAssistantAvatar: true }
    const next = { message: baseAssistantMessage, threadId: 't1', showAssistantAvatar: false }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })

  test('detects user message edit permission change', () => {
    const prev = { message: baseAssistantMessage, threadId: 't1', canEditUserMessage: false }
    const next = { message: baseAssistantMessage, threadId: 't1', canEditUserMessage: true }
    expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
  })
})

describe('stabilizeRuntimeMessages', () => {
  test('reuses the previous message reference when message identity is unchanged', () => {
    const cache = new Map()
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'hi',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 't0', text: 'hi' }],
      status: 'streaming',
      tokenCount: 2,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    // 第二帧传同引用 msg（引用未变）→ stabilize 复用
    const second = stabilizeRuntimeMessages([msg], cache)
    expect(second[0]).toBe(first[0])
  })

  test('stabilizes unchanged blocks within a changed message', () => {
    const cache = new Map()
    const toolBlock: RuntimeAssistantBlock = {
      type: 'tool_call',
      id: 'tool:tc1',
      toolCall: { id: 'tc1', toolName: 'Bash', input: {}, status: 'completed' },
    }
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'a',
      thinking: '',
      toolCalls: [],
      blocks: [toolBlock, { type: 'text', id: 't0', text: 'a' }],
      status: 'streaming',
      tokenCount: 1,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    const firstToolBlock = (first[0] as RuntimeAssistantMessageView).blocks[0]
    const changed: RuntimeAssistantMessageView = {
      ...msg,
      text: 'ab',
      tokenCount: 2,
      blocks: [toolBlock, { type: 'text', id: 't0', text: 'ab' }],
    }
    const second = stabilizeRuntimeMessages([changed], cache)
    expect(second[0]).not.toBe(first[0])
    expect((second[0] as RuntimeAssistantMessageView).blocks[0]).toBe(firstToolBlock)
  })

  test('drops cache entries for removed messages', () => {
    const cache = new Map()
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'x',
      thinking: '',
      toolCalls: [],
      blocks: [],
      status: 'completed',
      tokenCount: 1,
    }
    stabilizeRuntimeMessages([msg], cache)
    expect(cache.has('a1')).toBe(true)
    stabilizeRuntimeMessages([], cache)
    expect(cache.has('a1')).toBe(false)
  })

  test('does not reuse a message when content matches but identity differs', () => {
    const cache = new Map()
    const msg: RuntimeAssistantMessageView = {
      id: 'a1',
      type: 'assistant',
      text: 'hi',
      thinking: '',
      toolCalls: [],
      blocks: [{ type: 'text', id: 't0', text: 'hi' }],
      status: 'streaming',
      tokenCount: 2,
    }
    const first = stabilizeRuntimeMessages([msg], cache)
    // 内容相同但引用不同（新对象 + 新 block）→ 退化引用比较后不复用
    const rebuilt: RuntimeAssistantMessageView = { ...msg, blocks: [{ type: 'text', id: 't0', text: 'hi' }] }
    const second = stabilizeRuntimeMessages([rebuilt], cache)
    expect(second[0]).not.toBe(first[0])
  })
})
