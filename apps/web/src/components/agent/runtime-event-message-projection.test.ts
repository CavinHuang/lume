import { describe, expect, test } from 'bun:test'
import { projectRuntimeEventMessages } from './runtime-event-message-projection'
import type { LumeRuntimeEvent } from '@lume/shared'

function event(input: Partial<LumeRuntimeEvent> & Pick<LumeRuntimeEvent, 'type'>): LumeRuntimeEvent {
  return {
    id: `event:${input.type}`,
    type: input.type,
    threadId: 'thread-1',
    runId: 'run-1',
    createdAt: '2026-05-11T00:00:00.000Z',
    ...input,
  } as LumeRuntimeEvent
}

function usageEvent(outputTokens: number, scope: 'main' | 'subagent' | 'background' = 'main'): LumeRuntimeEvent {
  return event({
    type: 'usage.updated',
    scope,
    context: {
      source: 'provider',
      inputTokens: 40,
      outputTokens,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      cachedTokens: 3,
      totalTokens: 40 + outputTokens + 3,
      estimatedTailTokens: 0,
      contextWindow: 1000,
      contextWindowSource: 'model',
    },
    billing: {
      cumulative: {
        inputTokens: 40,
        outputTokens,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        cachedTokens: 3,
        totalTokens: 40 + outputTokens + 3,
      },
      latestRecord: {
        callerLabel: 'Turn 1',
        callerKind: 'conversation',
        inputTokens: 40,
        outputTokens,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        cachedTokens: 3,
        totalTokens: 40 + outputTokens + 3,
      },
      records: [],
      totalCostUSD: 0,
    },
  })
}

describe('runtime-event-message-projection', () => {
  test('projects RuntimeEvents into user, assistant, thinking, and tool blocks', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'user-1' }),
      event({ type: 'assistant.thinking_delta', delta: 'thinking...' }),
      event({ type: 'assistant.delta', delta: 'hello ' }),
      event({
        type: 'tool.started',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        inputPreview: { command: 'pwd' },
      }),
      event({
        type: 'tool.completed',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        resultPreview: 'ok',
      }),
      event({ type: 'assistant.delta', delta: 'world' }),
      event({ type: 'run.completed' }),
    ])

    expect(messages).toEqual([
      {
        id: 'user-1',
        type: 'user',
        text: 'hi',
        createdAt: '2026-05-11T00:00:00.000Z',
        messageId: 'user-1',
      },
      {
        id: 'assistant:run-1',
        type: 'assistant',
        text: 'hello world',
        thinking: 'thinking...',
        blocks: [
          { type: 'thinking', id: 'thinking:0', text: 'thinking...' },
          { type: 'text', id: 'text:1', text: 'hello ' },
          {
            type: 'tool_call',
            id: 'tool:tool-1',
            toolCall: {
              id: 'tool-1',
              toolName: 'Bash',
              input: { command: 'pwd' },
              status: 'completed',
              output: 'ok',
              isError: false,
            },
          },
          { type: 'text', id: 'text:3', text: 'world' },
        ],
        status: 'completed',
        completedAt: '2026-05-11T00:00:00.000Z',
        tokenCount: 13,
        toolCalls: [{
          id: 'tool-1',
          toolName: 'Bash',
          input: { command: 'pwd' },
          status: 'completed',
          output: 'ok',
          isError: false,
        }],
      },
    ])
  })

  test('routes subagent stream events to the Agent tool card instead of the main assistant', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: '写一篇文章', messageId: 'user-1' }),
      event({
        type: 'tool.started',
        toolCallId: 'agent-tool-1',
        toolName: 'Agent',
        inputPreview: { description: '起草文章', subagent_type: 'writer' },
      }),
      event({
        type: 'assistant.thinking_delta',
        delta: 'writer thinking',
        subagentRunId: 'subagent-run-1',
        parentToolUseId: 'agent-tool-1',
      } as any),
      event({
        type: 'assistant.delta',
        delta: 'writer output',
        subagentRunId: 'subagent-run-1',
        parentToolUseId: 'agent-tool-1',
      } as any),
    ])

    expect(messages[1]?.type).toBe('assistant')
    if (messages[1]?.type !== 'assistant') return
    expect(messages[1].text).toBe('')
    expect(messages[1].thinking).toBe('')
    expect(messages[1].blocks).toEqual([{
      type: 'tool_call',
      id: 'tool:agent-tool-1',
      toolCall: {
        id: 'agent-tool-1',
        toolName: 'Agent',
        input: { description: '起草文章', subagent_type: 'writer' },
        status: 'running',
        subagentRunId: 'subagent-run-1',
        subagentStatus: 'running',
      },
    }])
  })

  test('marks failed RuntimeEvent terminal state without dropping accumulated text', () => {
    expect(projectRuntimeEventMessages([
      event({ type: 'assistant.delta', delta: 'before failure' }),
      event({ type: 'run.failed', error: { code: 'runtime_error', message: 'boom' } }),
    ])).toEqual([{
      id: 'assistant:run-1',
      type: 'assistant',
      text: 'before failure',
      thinking: '',
      blocks: [{ type: 'text', id: 'text:0', text: 'before failure' }],
      status: 'failed',
      error: 'boom',
      tokenCount: 5,
      toolCalls: [],
    }])
  })

  test('adds estimated token usage to assistant messages', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'assistant.thinking_delta', delta: '1234' }),
      event({ type: 'assistant.delta', delta: '12345678' }),
      event({ type: 'run.completed' }),
    ])

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      tokenCount: 3,
    })
  })

  test('uses provider output token usage when usage.updated is available', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'assistant.thinking_delta', delta: '1234' }),
      event({ type: 'assistant.delta', delta: '12345678' }),
      usageEvent(9),
      event({ type: 'run.completed' }),
    ])

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      tokenCount: 9,
      tokenCountSource: 'provider',
      tokenUsage: {
        inputTokens: 40,
        outputTokens: 9,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        cachedTokens: 3,
        contextPercent: 5,
      },
    })
  })

  test('keeps assistant final message id and completion time for footer actions', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'assistant.delta', delta: 'hello' }),
      event({
        type: 'run.completed',
        finalMessageId: 'assistant-message-1',
        createdAt: '2026-05-11T07:23:00.000Z',
      }),
    ])

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      messageId: 'assistant-message-1',
      completedAt: '2026-05-11T07:23:00.000Z',
    })
  })

  test('applies provider token usage after the assistant message is closed', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'assistant.delta', delta: '12345678' }),
      event({ type: 'run.completed' }),
      usageEvent(9),
    ])

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      tokenCount: 9,
      tokenCountSource: 'provider',
      tokenUsage: {
        inputTokens: 40,
        outputTokens: 9,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        cachedTokens: 3,
        contextPercent: 5,
      },
    })
  })

  test('ignores subagent usage for the main assistant footer', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'assistant.delta', delta: '12345678' }),
      usageEvent(99, 'subagent'),
      event({ type: 'run.completed' }),
    ])

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      tokenCount: 2,
    })
    expect(messages[0]).not.toMatchObject({
      tokenCountSource: 'provider',
    })
  })

  test('attaches IM delivery status to the assistant message', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: '你好', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: '你好，我在。', messageId: 'assistant-1' }),
      event({ type: 'run.completed' }),
      event({
        type: 'im.delivery' as any,
        runId: 'message:assistant-1',
        messageId: 'assistant-1',
        status: 'pending',
        provider: 'weixin',
        accountId: 'account-1',
        peerKind: 'dm',
        peerId: 'user-1',
      } as any),
      event({
        type: 'im.delivery' as any,
        runId: 'message:assistant-1',
        messageId: 'assistant-1',
        status: 'sent',
        provider: 'weixin',
        accountId: 'account-1',
        peerKind: 'dm',
        peerId: 'user-1',
      } as any),
    ])

    expect(messages[1]).toMatchObject({
      type: 'assistant',
      imDelivery: {
        status: 'sent',
        provider: 'weixin',
        peerKind: 'dm',
        peerId: 'user-1',
      },
    })
  })

  test('shows a visible assistant notice when a run hits the turn limit without text', () => {
    expect(projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: '继续', messageId: 'user-1' }),
      event({ type: 'run.turn_limited', reason: 'Agent SDK 达到最大回合数（80），本轮需要继续执行。' }),
    ])).toEqual([
      {
        id: 'user-1',
        type: 'user',
        text: '继续',
        createdAt: '2026-05-11T00:00:00.000Z',
        messageId: 'user-1',
      },
      {
        id: 'assistant:run-1',
        type: 'assistant',
        text: '本轮已达到最大执行轮次，当前进度已保存。发送“继续”可接着执行。',
        thinking: '',
        blocks: [{
          type: 'text',
          id: 'text:0',
          text: '本轮已达到最大执行轮次，当前进度已保存。发送“继续”可接着执行。',
        }],
        status: 'completed',
        tokenCount: 8,
        toolCalls: [],
      },
    ])
  })

  test('keeps context compaction start and completion visible as a status timeline', () => {
    expect(projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: '继续', messageId: 'user-1' }),
      event({
        type: 'context.compaction.started',
        id: 'compact-start',
        trigger: 'auto',
        preTokens: 900,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
      }),
      event({
        type: 'context.compaction.completed',
        id: 'compact-complete',
        trigger: 'auto',
        preTokens: 900,
        postTokens: 280,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
      }),
    ])).toEqual([
      {
        id: 'user-1',
        type: 'user',
        text: '继续',
        createdAt: '2026-05-11T00:00:00.000Z',
        messageId: 'user-1',
      },
      {
        id: 'compact-start',
        type: 'system',
        variant: 'context_compaction',
        status: 'active',
        text: '正在自动压缩上下文',
        createdAt: '2026-05-11T00:00:00.000Z',
      },
      {
        id: 'compact-complete',
        type: 'system',
        variant: 'context_compaction',
        status: 'completed',
        text: '上下文已自动压缩',
        createdAt: '2026-05-11T00:00:00.000Z',
      },
    ])
  })

  test('projects user message attachments', () => {
    expect(projectRuntimeEventMessages([
      event({
        type: 'message.user.submitted',
        text: 'read this',
        messageId: 'user-attachments',
        attachments: [{
          id: 'att-1',
          filename: 'brief.md',
          mediaType: 'text/markdown',
          size: 2048,
          threadPath: 'docs/brief.md',
        }],
      }),
    ])[0]).toEqual({
      id: 'user-attachments',
      type: 'user',
      text: 'read this',
      createdAt: '2026-05-11T00:00:00.000Z',
      attachments: [{
        id: 'att-1',
        filename: 'brief.md',
        mediaType: 'text/markdown',
        size: 2048,
        threadPath: 'docs/brief.md',
      }],
      messageId: 'user-attachments',
    })
  })

  test('marks timed out tool permission failures for the tool title badge', () => {
    const messages = projectRuntimeEventMessages([
      event({
        type: 'tool.started',
        toolCallId: 'tool-timeout',
        toolName: 'Bash',
        inputPreview: { command: 'sleep 1' },
      }),
      event({
        type: 'tool.failed',
        toolCallId: 'tool-timeout',
        toolName: 'Bash',
        error: {
          code: 'tool_error',
          message: '工具权限确认超时: Bash',
        },
      }),
    ])

    expect(messages[0]?.type).toBe('assistant')
    if (messages[0]?.type !== 'assistant') return
    expect(messages[0].toolCalls[0]).toMatchObject({
      id: 'tool-timeout',
      status: 'failed',
      isError: true,
      permissionState: 'timeout',
    })
  })

  test('marks a running tool as permission timed out when the timeout RuntimeEvent arrives', () => {
    const messages = projectRuntimeEventMessages([
      event({
        type: 'tool.started',
        toolCallId: 'tool-timeout',
        toolName: 'Bash',
        inputPreview: { command: 'sleep 1' },
      }),
      event({
        type: 'tool.permission_timeout',
        toolCallId: 'tool-timeout',
        requestId: 'tool-timeout',
        toolName: 'Bash',
        message: '工具权限确认超时: Bash',
      }),
    ])

    expect(messages[0]?.type).toBe('assistant')
    if (messages[0]?.type !== 'assistant') return
    expect(messages[0].toolCalls[0]).toMatchObject({
      id: 'tool-timeout',
      toolName: 'Bash',
      status: 'failed',
      output: '工具权限确认超时: Bash',
      isError: true,
      permissionState: 'timeout',
    })
  })

  test('projects task progress RuntimeEvents as assistant task blocks', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'run the plan', messageId: 'user-1' }),
      event({
        type: 'task.progress',
        taskRunId: 'taskrun-1',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-1',
        tasks: [{
          id: 'task-1',
          title: 'Patch',
          status: 'running',
          attemptCount: 1,
        }],
        message: '开始执行：Patch',
      }),
    ])

    expect(messages[1]).toMatchObject({
      id: 'assistant:run-1',
      type: 'assistant',
      text: '开始执行：Patch',
      blocks: [{
        type: 'task_progress',
        id: 'task:taskrun-1:2026-05-11T00:00:00.000Z',
        event: {
          type: 'task.progress',
          taskRunId: 'taskrun-1',
          contractId: 'contract-1',
          status: 'running',
          currentTaskId: 'task-1',
          message: '开始执行：Patch',
        },
      }],
      status: 'streaming',
    })
  })

  test('keeps only the latest task progress block at the assistant message bottom', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'run the plan', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: 'Starting. ' }),
      event({
        type: 'task.progress',
        taskRunId: 'taskrun-1',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-1',
        tasks: [{
          id: 'task-1',
          title: 'Patch files',
          status: 'running',
          attemptCount: 1,
        }],
        message: '正在执行：Patch files',
      }),
      event({ type: 'assistant.delta', delta: 'Still working. ' }),
      event({
        type: 'task.progress',
        taskRunId: 'taskrun-1',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-2',
        tasks: [{
          id: 'task-2',
          title: 'Run tests',
          status: 'running',
          attemptCount: 1,
        }],
        message: '正在执行：Run tests',
      }),
    ])

    expect(messages[1]).toMatchObject({
      text: 'Starting. Still working. 正在执行：Run tests',
      blocks: [
        { type: 'text', text: 'Starting. ' },
        { type: 'text', text: 'Still working. ' },
        {
          type: 'task_progress',
          event: {
            currentTaskId: 'task-2',
            message: '正在执行：Run tests',
          },
        },
      ],
    })
  })

  test('projects task progress after a completed plan message as a new streaming assistant status', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'make a plan', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: 'Here is the plan.' }),
      event({ type: 'run.completed' }),
      event({
        type: 'task.progress',
        runId: 'run-execute-1',
        taskRunId: 'taskrun-1',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-1',
        tasks: [{
          id: 'task-1',
          title: 'Patch files',
          status: 'running',
          attemptCount: 1,
        }],
        message: '正在执行：Patch files',
      }),
    ])

    expect(messages).toMatchObject([
      { type: 'user', text: 'make a plan' },
      {
        id: 'assistant:run-1',
        type: 'assistant',
        text: 'Here is the plan.',
        status: 'completed',
      },
      {
        id: 'assistant:task:taskrun-1',
        type: 'assistant',
        text: '正在执行：Patch files',
        blocks: [{
          type: 'task_progress',
          event: {
            type: 'task.progress',
            runId: 'run-execute-1',
            taskRunId: 'taskrun-1',
            message: '正在执行：Patch files',
          },
        }],
        status: 'streaming',
      },
    ])
  })

  test('projects plan preview RuntimeEvents as assistant plan blocks and copyable text', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'make a plan', messageId: 'user-1' }),
      event({
        type: 'plan.preview',
        contractId: 'plan-1',
        title: 'Ship runtime',
        summary: 'Review before executing',
        markdown: '# Ship runtime\n\n## Steps\n1. Inspect',
        planFilePath: 'plans/plan-1.md',
        planVerified: true,
        stepCount: 1,
      } as any),
    ])

    expect(messages[1]).toMatchObject({
      id: 'assistant:run-1',
      type: 'assistant',
      text: '# Ship runtime\n\n## Steps\n1. Inspect',
      blocks: [{
        type: 'plan_preview',
        id: 'plan:plan-1',
        preview: {
          contractId: 'plan-1',
          title: 'Ship runtime',
          summary: 'Review before executing',
          markdown: '# Ship runtime\n\n## Steps\n1. Inspect',
          planFilePath: 'plans/plan-1.md',
          planVerified: true,
          stepCount: 1,
        },
      }],
      status: 'streaming',
    })
  })

  test('projects memory context used RuntimeEvents as a bottom notice block', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'continue', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: 'Continuing.' }),
      event({
        type: 'memory.context.used',
        items: [{
          id: 'mem_1',
          kind: 'decision',
          scope: 'workspace',
          status: 'active',
          citation: '/tmp/memory/entries/mem_1.md',
          reason: 'matched memory entry',
        }],
        hidden: true,
      }),
    ])

    expect(messages[1]).toMatchObject({
      type: 'assistant',
      blocks: [
        { type: 'text', text: 'Continuing.' },
        {
          type: 'memory_context_used',
          event: {
            type: 'memory.context.used',
            items: [{ id: 'mem_1' }],
          },
        },
      ],
    })
  })
})
