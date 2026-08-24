import { describe, expect, test } from 'bun:test'
import { projectRuntimeEventMessages, applyRuntimeEventsIncremental, type ProjectionRef } from './runtime-event-message-projection'
import { hydrateRuntimeEvents } from '@/hooks/runtime-event-state'
import type { LumeRuntimeEvent } from '@lume/shared'
import type { RuntimeMessageView } from './runtime-message-view'

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
  test('retracts a failed partial model attempt and keeps retry state temporary', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'hello' }),
      event({ type: 'assistant.delta', delta: 'failed partial' }),
      event({
        type: 'model.retry',
        phase: 'waiting',
        attempt: 1,
        maxRetries: 5,
        retryDelayMs: 1_000,
        errorStatus: 503,
      }),
      event({ type: 'model.retry_cleared' }),
      event({ type: 'assistant.delta', delta: 'successful response' }),
    ])
    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant).toMatchObject({
      type: 'assistant',
      text: 'successful response',
    })
    if (assistant?.type === 'assistant') expect(assistant.retry).toBeUndefined()
  })
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
              startedAt: '2026-05-11T00:00:00.000Z',
              durationMs: 0,
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
          startedAt: '2026-05-11T00:00:00.000Z',
          durationMs: 0,
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
        startedAt: '2026-05-11T00:00:00.000Z',
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

  test('compaction split keeps assistant message ids unique (no React key collision)', () => {
    // 同一 run 内发生 context compaction：compaction 前的 assistant 内容被 flush，
    // compaction 后同 runId 继续输出。投影不得复用同一个 `assistant:${runId}` id，
    // 否则 AgentMessages 列表会出现两条同 key 消息 → React duplicate/omit + 列表跳变。
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: 'before compaction ' }),
      event({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: { command: 'pwd' } }),
      event({ type: 'tool.completed', toolCallId: 'tool-1', toolName: 'Bash', resultPreview: 'ok' }),
      event({
        type: 'context.compaction.started',
        id: 'compact-start',
        trigger: 'auto',
        preTokens: 900,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
      }),
      event({ type: 'assistant.delta', delta: 'after compaction' }),
      event({ type: 'run.completed' }),
    ])

    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    // compaction 前后各一条 assistant，id 必须不同
    const assistantIds = ids.filter((id) => id.startsWith('assistant:'))
    expect(assistantIds).toHaveLength(2)
    expect(assistantIds[0]).not.toBe(assistantIds[1])
  })

  test('keeps all context compaction stages in one stable status message', () => {
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
        type: 'context.compaction.progress',
        id: 'compact-progress',
        trigger: 'auto',
        preTokens: 900,
        stage: 'summarizing',
        progress: 45,
        message: '正在生成上下文摘要',
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
        status: 'completed',
        text: '上下文已自动压缩',
        createdAt: '2026-05-11T00:00:00.000Z',
      },
    ])
  })

  test('shows compaction failure without exposing a rejected summary', () => {
    expect(projectRuntimeEventMessages([
      event({
        type: 'context.compaction.started',
        id: 'compact-failed',
        trigger: 'auto',
        preTokens: 240_000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
      }),
      event({
        type: 'context.compaction.completed',
        id: 'compact-failed-boundary',
        trigger: 'auto',
        preTokens: 240_000,
        postTokens: 240_000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
        outcome: 'failed',
        failureReason: 'max_tokens',
        summary: 'rejected summary',
      }),
    ])).toEqual([{
      id: 'compact-failed',
      type: 'system',
      variant: 'context_compaction',
      status: 'completed',
      text: '上下文压缩失败，已保留原上下文',
      createdAt: '2026-05-11T00:00:00.000Z',
    }])
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

  test('tool.started 幂等:双 id 空间(旧路 persisted + lifecycle 总线)同 toolCallId 只产单卡单 block', () => {
    // 批次2 双投链路:hydrate 合并按 event.id 去重,旧路 `${runId}:${item.id}` 与总线
    // `lifecycle:{seq}` 互异 → 双 tool.started 存活 → 投影不得 push 两个 block。
    const messages = projectRuntimeEventMessages([
      event({ id: 'run-1:call-1:tool.started', type: 'tool.started', toolCallId: 'call-1', toolName: 'Bash', inputPreview: { command: 'pwd' } }),
      event({ id: 'lifecycle:9:tool.started', type: 'tool.started', toolCallId: 'call-1', toolName: 'Bash', inputPreview: { command: 'pwd' } }),
      event({ id: 'run-1:call-1:tool.completed', type: 'tool.completed', toolCallId: 'call-1', toolName: 'Bash', resultPreview: 'ok' }),
    ])

    expect(messages[0]?.type).toBe('assistant')
    if (messages[0]?.type !== 'assistant') return
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].blocks.filter((block) => block.id === 'tool:call-1')).toHaveLength(1)
    expect(messages[0].toolCalls[0]).toMatchObject({ id: 'call-1', status: 'completed', output: 'ok' })
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
        id: 'assistant:task:taskrun-1:run-execute-1',
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

  test('keeps task status message ids unique when a task run continues across execution runs', () => {
    const messages = projectRuntimeEventMessages([
      event({
        type: 'task.progress',
        runId: 'run-execute-1',
        taskRunId: 'taskrun-shared',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-1',
        tasks: [{
          id: 'task-1',
          title: 'First task',
          status: 'running',
          attemptCount: 1,
        }],
        message: '正在执行：First task',
      }),
      event({ type: 'run.completed', runId: 'run-execute-1' }),
      event({
        type: 'task.progress',
        runId: 'run-execute-2',
        taskRunId: 'taskrun-shared',
        contractId: 'contract-1',
        status: 'running',
        currentTaskId: 'task-2',
        tasks: [{
          id: 'task-2',
          title: 'Second task',
          status: 'running',
          attemptCount: 1,
        }],
        message: '正在执行：Second task',
      }),
      event({ type: 'run.completed', runId: 'run-execute-2' }),
    ])
    const ids = messages.map(message => message.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'assistant:task:taskrun-shared:run-execute-1',
      'assistant:task:taskrun-shared:run-execute-2',
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

  test('keeps one run-start file binding on streaming text, plan preview, and the completed message', () => {
    const fileReferenceBinding = {
      workspaceSlug: 'demo',
      projectRootFingerprint: 'b'.repeat(64),
      fileContextId: 'context-1',
    }
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started', fileReferenceBinding, fileReferenceProtocolVersion: 1 }),
      event({ type: 'assistant.delta', delta: 'See `@project/src/app.ts#L4`.', fileReferenceBinding, fileReferenceProtocolVersion: 1 }),
      event({
        type: 'plan.preview',
        fileReferenceBinding,
        fileReferenceProtocolVersion: 1,
        contractId: 'plan-bound',
        title: 'Bound plan',
        markdown: 'Inspect `@session/plans/plan.md`.',
        stepCount: 1,
      } as any),
      event({ type: 'run.completed', fileReferenceBinding, fileReferenceProtocolVersion: 1 }),
    ])

    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant).toMatchObject({
      type: 'assistant',
      status: 'completed',
      fileReferenceBinding,
      fileReferenceProtocolVersion: 1,
    })
    expect((assistant as Extract<RuntimeMessageView, { type: 'assistant' }>).blocks.some((block) => (
      block.type === 'plan_preview' && block.id === 'plan:plan-bound'
    ))).toBe(true)
    expect((assistant as Extract<RuntimeMessageView, { type: 'assistant' }>).fileReferenceBinding).toBe(fileReferenceBinding)
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

  test('projects background memory changes after a terminal run as replayable system messages', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: '以后默认中文', messageId: 'user-memory' }),
      event({ type: 'assistant.delta', delta: '好的。' }),
      event({ type: 'run.completed' }),
      event({
        type: 'memory.changed',
        actor: 'background_extract',
        workspaceSlug: 'demo',
        mutationIds: ['mutation-1'],
        memoryIds: ['memory-1'],
        summary: '后台记住了 1 条信息',
        details: [{
          mutationId: 'mutation-1',
          action: 'created',
          scope: 'global',
          memoryIds: ['memory-1'],
          summary: '已记住 1 条信息',
          undoable: true,
        }],
      }),
    ])
    expect(messages.at(-1)).toMatchObject({
      type: 'system',
      variant: 'memory_saved',
      text: '后台记住了 1 条信息',
      workspaceSlug: 'demo',
      target: {
        section: 'memory',
        workspaceSlug: 'demo',
        libraryView: 'recent',
        memoryId: 'memory-1',
        mutationId: 'mutation-1',
      },
    })
  })

  test('upserts memory.changed messages sharing one id (live + replay dedupe, no ghost duplicate)', () => {
    const memoryChanged = (id: string, summary: string) => event({
      id,
      type: 'memory.changed',
      actor: 'consolidation',
      workspaceSlug: 'demo',
      mutationIds: [],
      memoryIds: [],
      summary,
      details: [],
    })
    const messages = projectRuntimeEventMessages([
      memoryChanged('run-1:memory.changed:uuid-same', '整理了 1 条记忆'),
      memoryChanged('run-1:memory.changed:uuid-same', '整理了 2 条记忆'),
    ])
    const same = messages.filter((message) => message.id === 'run-1:memory.changed:uuid-same')
    expect(same).toHaveLength(1)
    expect(same[0]).toMatchObject({ type: 'system', variant: 'memory_saved', text: '整理了 2 条记忆' })
  })

  test('keeps distinct memory.changed messages side by side', () => {
    const memoryChanged = (id: string, summary: string) => event({
      id,
      type: 'memory.changed',
      actor: 'consolidation',
      workspaceSlug: 'demo',
      mutationIds: [],
      memoryIds: [],
      summary,
      details: [],
    })
    const messages = projectRuntimeEventMessages([
      memoryChanged('run-1:memory.changed:uuid-a', '整理了 1 条记忆'),
      memoryChanged('run-1:memory.changed:uuid-b', '整理了 3 条记忆'),
    ])
    expect(messages.filter((message) => message.id === 'run-1:memory.changed:uuid-a')).toHaveLength(1)
    expect(messages.filter((message) => message.id === 'run-1:memory.changed:uuid-b')).toHaveLength(1)
  })

  test('projects one updating AutoDream job message', () => {
    const messages = projectRuntimeEventMessages([
      event({
        type: 'memory.job.progress',
        jobId: 'job-1',
        jobKind: 'consolidation',
        phase: '检查近期证据',
        scannedItems: 10,
        processedItems: 4,
        changedItems: 0,
      }),
      event({
        type: 'memory.job.completed',
        jobId: 'job-1',
        jobKind: 'consolidation',
        status: 'completed',
        summary: '整理了 2 条记忆',
        changedItems: 2,
      }),
    ])
    expect(messages).toEqual([expect.objectContaining({
      id: 'memory-job:job-1',
      type: 'system',
      variant: 'memory_job',
      status: 'completed',
      text: '整理了 2 条记忆',
      target: { section: 'activity', jobId: 'job-1' },
    })])
  })
})

/** 模拟「事件逐个追加」的增量调用，返回最终 messages（用于与全量对比）。 */
function incrementalProject(events: LumeRuntimeEvent[]): RuntimeMessageView[] {
  let ref: ProjectionRef | null = null
  let messages: RuntimeMessageView[] = []
  for (let i = 1; i <= events.length; i++) {
    const result = applyRuntimeEventsIncremental(events.slice(0, i), ref)
    ref = result.ref
    messages = result.messages
  }
  return messages
}

describe('applyRuntimeEventsIncremental 与全量投影等价', () => {
  test('纯 assistant.delta 追加：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'u1' }),
      event({ type: 'run.started', runId: 'r1' }),
      event({ type: 'assistant.delta', runId: 'r1', delta: 'Hello' }),
      event({ type: 'assistant.delta', runId: 'r1', delta: ' world' }),
      event({ type: 'run.completed', runId: 'r1', finalMessageId: 'a1' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('tool 调用序列：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'run tool', messageId: 'u2' }),
      event({ type: 'run.started', runId: 'r2' }),
      event({ type: 'tool.started', runId: 'r2', toolCallId: 't1', toolName: 'Read', createdAt: '2026-05-11T00:00:01.000Z' }),
      event({ type: 'assistant.delta', runId: 'r2', delta: 'reading' }),
      event({ type: 'tool.completed', runId: 'r2', toolCallId: 't1', toolName: 'Read', createdAt: '2026-05-11T00:00:02.000Z', resultPreview: 'ok' }),
      event({ type: 'run.completed', runId: 'r2', finalMessageId: 'a2' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('多轮对话（多 user/assistant turn）：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'q1', messageId: 'u3' }),
      event({ type: 'run.started', runId: 'r3' }),
      event({ type: 'assistant.delta', runId: 'r3', delta: 'a1' }),
      event({ type: 'run.completed', runId: 'r3', finalMessageId: 'a3' }),
      event({ type: 'message.user.submitted', text: 'q2', messageId: 'u4' }),
      event({ type: 'run.started', runId: 'r4' }),
      event({ type: 'assistant.delta', runId: 'r4', delta: 'a2' }),
      event({ type: 'run.completed', runId: 'r4', finalMessageId: 'a4' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('usage.updated / im.delivery 等辅助事件：增量结果 == 全量', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'u5' }),
      event({ type: 'run.started', runId: 'r5' }),
      event({ type: 'assistant.delta', runId: 'r5', delta: 'x' }),
      usageEvent(5),
      event({ type: 'run.completed', runId: 'r5', finalMessageId: 'a5' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('version turn 切换（触发 fallback）：增量结果 == 全量', () => {
    // 两组同 versionGroupId 的 user.submitted，versionIndex 递增 → keepLatestVersionTurns 只保留高 version
    const events = [
      event({ type: 'message.user.submitted', text: 'v1', messageId: 'u-v1', versionGroupId: 'vg1', versionIndex: 0, versionCount: 2 } as any),
      event({ type: 'run.started', runId: 'r-v1' }),
      event({ type: 'assistant.delta', runId: 'r-v1', delta: 'old' }),
      event({ type: 'run.completed', runId: 'r-v1', finalMessageId: 'a-v1' }),
      event({ type: 'message.user.submitted', text: 'v2', messageId: 'u-v2', versionGroupId: 'vg1', versionIndex: 1, versionCount: 2 } as any),
      event({ type: 'run.started', runId: 'r-v2' }),
      event({ type: 'assistant.delta', runId: 'r-v2', delta: 'new' }),
      event({ type: 'run.completed', runId: 'r-v2', finalMessageId: 'a-v2' }),
    ]
    expect(incrementalProject(events)).toEqual(projectRuntimeEventMessages(events))
  })

  test('compact 截断（事件回退）：增量结果 == 全量', () => {
    // 先增量投 5 事件，再用前 2 事件重投（模拟 compact 后 events 缩短）→ fallback
    const full = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u6' }),
      event({ type: 'run.started', runId: 'r6' }),
      event({ type: 'assistant.delta', runId: 'r6', delta: 'a' }),
      event({ type: 'assistant.delta', runId: 'r6', delta: 'b' }),
      event({ type: 'run.completed', runId: 'r6', finalMessageId: 'a6' }),
    ]
    let ref: ProjectionRef | null = null
    let messages: RuntimeMessageView[] = []
    for (let i = 1; i <= full.length; i++) {
      const result = applyRuntimeEventsIncremental(full.slice(0, i), ref)
      ref = result.ref
      messages = result.messages
    }
    // compact：events 缩短为前 2 个
    const afterCompact = applyRuntimeEventsIncremental(full.slice(0, 2), ref)
    expect(afterCompact.messages).toEqual(projectRuntimeEventMessages(full.slice(0, 2)))
  })

  test('tool.output 旧槽位原地替换（非尾部）经增量路径到达视图', () => {
    const outV1 = event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'v1\n', createdAt: '2026-05-11T00:00:01.000Z' })
    const outV2 = { ...outV1, chunk: 'v1\nv2\n' }
    const progress = event({ id: 'bg-1', type: 'task.progress', taskId: 'bg-1', progress: {}, createdAt: '2026-05-11T00:00:02.000Z' })

    // 第一帧：快照在非尾部槽位，其后已有插队事件
    const frame1 = [
      event({ type: 'run.started' }),
      event({ type: 'tool.started', runId: 'run-1', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: {} }),
      outV1,
      progress,
    ]
    const r1 = applyRuntimeEventsIncremental(frame1, null)

    // 第二帧：同长度、尾引用不变，仅中段替换——替换必须可见
    const frame2 = [frame1[0], frame1[1], outV2, frame1[3]]
    const r2 = applyRuntimeEventsIncremental(frame2 as LumeRuntimeEvent[], r1.ref)

    const assistant = r2.messages.find((message) => message.type === 'assistant') as Extract<RuntimeMessageView, { type: 'assistant' }>
    const block = assistant.blocks.find((candidate) => candidate.type === 'tool_call') as Extract<typeof assistant.blocks[number], { type: 'tool_call' }>
    expect(block.toolCall.streamedOutput).toBe('v1\nv2\n')

    // 与全量投影等价
    expect(r2.messages).toEqual(projectRuntimeEventMessages(frame2 as LumeRuntimeEvent[]))
  })

  test('failed 后迟到的 tool.output 快照经增量路径不复活卡片', () => {
    const base = [
      event({ type: 'run.started' }),
      event({ type: 'tool.started', runId: 'run-1', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: {} }),
      event({ type: 'tool.failed', runId: 'run-1', toolCallId: 'tool-1', toolName: 'Bash', error: { code: 'tool_error', message: 'boom' } }),
    ]
    const r1 = applyRuntimeEventsIncremental(base, null)
    const late = [...base, event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'late', createdAt: '2026-05-11T00:00:05.000Z' })]
    const r2 = applyRuntimeEventsIncremental(late, r1.ref)

    const assistant = r2.messages.find((message) => message.type === 'assistant') as Extract<RuntimeMessageView, { type: 'assistant' }>
    const block = assistant.blocks.find((candidate) => candidate.type === 'tool_call') as Extract<typeof assistant.blocks[number], { type: 'tool_call' }>
    expect(block.toolCall.status).toBe('failed')
    expect(block.toolCall.streamedOutput).toBeUndefined()
  })
})

describe('applyRuntimeEventsIncremental 引用稳定', () => {
  test('纯追加：未变历史消息引用跨帧不变', () => {
    const base = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u7' }),
      event({ type: 'run.started', runId: 'r7' }),
      event({ type: 'assistant.delta', runId: 'r7', delta: 'first' }),
      event({ type: 'run.completed', runId: 'r7', finalMessageId: 'a7' }),
    ]
    const r1 = applyRuntimeEventsIncremental(base, null)
    // 第一帧：user 消息（index 0）引用
    const userMsgRef = r1.messages[0]

    // 追加新 turn
    const extended = [
      ...base,
      event({ type: 'message.user.submitted', text: 'q2', messageId: 'u8' }),
      event({ type: 'run.started', runId: 'r8' }),
      event({ type: 'assistant.delta', runId: 'r8', delta: 'second' }),
    ]
    const r2 = applyRuntimeEventsIncremental(extended, r1.ref)
    // 历史首条 user 消息引用不变（增量未 touch）
    expect(r2.messages[0]).toBe(userMsgRef)
    // 且内容仍正确
    expect(r2.messages[0]).toMatchObject({ id: 'u7', type: 'user' })
  })

  test('同一流式 assistant 的 text block 引用稳定（增量 mutate 不重建历史 block）', () => {
    const events = [
      event({ type: 'message.user.submitted', text: 'q', messageId: 'u9' }),
      event({ type: 'run.started', runId: 'r9' }),
      event({ type: 'assistant.delta', runId: 'r9', delta: 'Hello' }),
    ]
    const r1 = applyRuntimeEventsIncremental(events, null)
    const r2 = applyRuntimeEventsIncremental(
      [...events, event({ type: 'assistant.delta', runId: 'r9', delta: ' world' })],
      r1.ref,
    )
    // 流式 assistant 消息每帧是新快照（currentAssistant 快照），但其内 text block 引用应稳定
    const assistant1 = r1.messages.at(-1)!
    const assistant2 = r2.messages.at(-1)!
    expect(assistant1.type).toBe('assistant')
    expect(assistant2.type).toBe('assistant')
    // 第一个 text block 引用稳定（appendAssistantTextBlock mutate 同一 block）
    if (assistant1.type === 'assistant' && assistant2.type === 'assistant') {
      const textBlock1 = assistant1.blocks.find((b) => b.type === 'text')!
      const textBlock2 = assistant2.blocks.find((b) => b.type === 'text')!
      expect(textBlock2).toBe(textBlock1)
      expect((textBlock2 as any).text).toBe('Hello world')
    }
  })
})

describe('todo_update block 稳定性', () => {
  test('多次 todo.state_updated 事件：block id 跨事件稳定（不带变化的 createdAt）', () => {
    // 简洁模式下 MinimalProcessGroup 段 key = `process:${段首block.id}`。
    // 若 todo_update 为段首且 id 含每次事件都不同的 createdAt，段 key 会漂移 →
    // React 卸载重建整个 process 段 → 列表抖动 + 滚动跳顶。
    // 故同 run 内 todo_update block id 必须稳定（filter 已保证单例，runId 足够唯一）。
    const events = [
      event({ type: 'message.user.submitted', text: 'do task', messageId: 'u-todo' }),
      event({ type: 'run.started', runId: 'r-todo' }),
      event({
        type: 'todo.state_updated',
        runId: 'r-todo',
        createdAt: '2026-05-11T00:00:01.000Z',
        todos: [
          { content: 'step1', status: 'in_progress' },
          { content: 'step2', status: 'pending' },
        ],
        currentActiveForm: 'doing step1',
      }),
      event({
        type: 'todo.state_updated',
        runId: 'r-todo',
        createdAt: '2026-05-11T00:00:05.000Z',
        todos: [
          { content: 'step1', status: 'completed' },
          { content: 'step2', status: 'in_progress' },
        ],
        currentActiveForm: 'doing step2',
      }),
    ]
    const messages = projectRuntimeEventMessages(events)
    const assistant = messages.find((m) => m.type === 'assistant')!
    expect(assistant.type).toBe('assistant')
    if (assistant.type !== 'assistant') return
    const todoBlocks = assistant.blocks.filter((b) => b.type === 'todo_update')
    // filter 保证同 run 内只有一个 todo_update block
    expect(todoBlocks.length).toBe(1)
    // id 不含变化的 createdAt，跨事件稳定
    expect(todoBlocks[0]!.id).toBe('todo:r-todo')
    // 内容仍为最新一次 todo 状态
    expect((todoBlocks[0] as any).data.currentActiveForm).toBe('doing step2')
  })

  test('assistant text/thinking block ids stay stable across a fallback re-projection', () => {
    // D4 验证：text/thinking block id 基于 blocks.length。若全量回退（hydrate/version turn）
    // 重投影后 id 漂移，简洁模式 process 段 key（process:段首block.id）会变 → MinimalProcessGroup remount。
    const events: LumeRuntimeEvent[] = [
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'user-1' }),
      event({ type: 'assistant.thinking_delta', delta: 'thinking...' }),
      event({ type: 'assistant.delta', delta: 'hello ' }),
      event({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: { command: 'pwd' } }),
      event({ type: 'tool.completed', toolCallId: 'tool-1', toolName: 'Bash', resultPreview: 'ok' }),
      event({ type: 'assistant.delta', delta: 'world' }),
      event({ type: 'assistant.final', blocks: [{ type: 'thinking', text: 'thinking...' }, { type: 'text', text: 'hello world' }] }),
      event({ type: 'run.completed' }),
    ]

    const assistantBlockIds = (messages: RuntimeMessageView[]): string[] => {
      const a = messages.find((m) => m.type === 'assistant')
      return a?.type === 'assistant' ? a.blocks.map((b) => b.id) : []
    }

    // 增量累积 apply（模拟流式逐帧）
    let ref: ProjectionRef | null = null
    let messages: RuntimeMessageView[] = []
    for (let i = 1; i <= events.length; i++) {
      const result = applyRuntimeEventsIncremental(events.slice(0, i), ref)
      ref = result.ref
      messages = result.messages
    }
    const idsBeforeFallback = assistantBlockIds(messages)

    // 模拟 hydrate：相同内容、全新引用的事件数组 → canApplyIncrementally 因引用变化返回 false → 全量 fallback
    const eventsCopy: LumeRuntimeEvent[] = JSON.parse(JSON.stringify(events))
    const fallbackResult = applyRuntimeEventsIncremental(eventsCopy, ref)
    const idsAfterFallback = assistantBlockIds(fallbackResult.messages)

    expect(idsAfterFallback).toEqual(idsBeforeFallback)
  })

  test('projects coding execution metadata and completion report for the existing UI', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: '修复测试', messageId: 'user-1' }),
      event({
        type: 'tool.started',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        inputPreview: { command: 'bun test' },
        riskLevel: 'medium',
      }),
      event({
        type: 'tool.completed',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        resultPreview: '1 pass',
        execution: {
          version: 1,
          durationMs: 25,
          command: 'bun test',
          purpose: 'verification',
          terminationReason: 'completed',
        },
      }),
      event({
        type: 'run.completed',
        codingReport: {
          status: 'verified',
          workspaceChanged: true,
          changedFiles: ['src/fix.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])
    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') return
    expect(assistant.codingReport?.status).toBe('verified')
    expect(assistant.codingReport?.changedFiles).toEqual(['src/fix.ts'])
    expect(assistant.toolCalls[0]).toMatchObject({
      riskLevel: 'medium',
      execution: { command: 'bun test', purpose: 'verification' },
    })
  })

  test('preserves a coding report while the run is active so terminal events can reuse it', () => {
    const activeMessages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: '修复测试', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: '正在修改' }),
      event({
        type: 'coding.report.updated',
        codingReport: {
          status: 'unverified',
          workspaceChanged: true,
          changedFiles: ['src/fix.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const activeAssistant = activeMessages.find((message) => message.type === 'assistant')
    expect(activeAssistant?.type === 'assistant' ? activeAssistant.codingReport : undefined).toMatchObject({
      status: 'unverified',
      changedFiles: ['src/fix.ts'],
    })

    const completedMessages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'message.user.submitted', text: '修复测试', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: '修改完成' }),
      event({
        type: 'run.completed',
        codingReport: {
          status: 'verified',
          workspaceChanged: true,
          changedFiles: ['src/fix.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const completedAssistant = completedMessages.find((message) => message.type === 'assistant')
    expect(completedAssistant?.type === 'assistant' ? completedAssistant.codingReport : undefined).toMatchObject({
      status: 'verified',
      changedFiles: ['src/fix.ts'],
    })
  })

  test('updates the completed assistant when a background verification finishes later', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started', runId: 'run-background' }),
      event({ type: 'assistant.delta', runId: 'run-background', delta: '已在后台验证' }),
      event({
        type: 'run.completed',
        runId: 'run-background',
        codingReport: {
          status: 'unverified',
          workspaceChanged: true,
          changedFiles: ['src/fix.ts'],
          externalChangedFiles: [],
          pendingBackground: true,
        },
      }),
      event({
        type: 'coding.report.updated',
        runId: 'run-background',
        codingReport: {
          status: 'verified',
          workspaceChanged: true,
          changedFiles: ['src/fix.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') return
    expect(assistant.codingReport).toMatchObject({
      status: 'verified',
      pendingBackground: false,
      changedFiles: ['src/fix.ts'],
    })
  })

  test('projects the final coding report when the run reaches its turn limit', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started', runId: 'run-limited' }),
      event({ type: 'assistant.delta', runId: 'run-limited', delta: '已完成部分修改' }),
      event({
        type: 'run.turn_limited',
        runId: 'run-limited',
        codingReport: {
          status: 'unverified',
          workspaceChanged: true,
          changedFiles: ['src/limited.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') return
    expect(assistant.status).toBe('completed')
    expect(assistant.codingReport?.changedFiles).toEqual(['src/limited.ts'])
  })

  test('projects and refreshes the final coding report for a failed run', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started', runId: 'run-failed' }),
      event({ type: 'assistant.delta', runId: 'run-failed', delta: '修改后验证失败' }),
      event({
        type: 'run.failed',
        runId: 'run-failed',
        error: { code: 'verification_failed', message: '测试失败' },
        codingReport: {
          status: 'failed',
          workspaceChanged: true,
          changedFiles: ['src/failed.ts'],
          externalChangedFiles: [],
          pendingBackground: true,
        },
      }),
      event({
        type: 'coding.report.updated',
        runId: 'run-failed',
        codingReport: {
          status: 'failed',
          workspaceChanged: true,
          changedFiles: ['src/failed.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const assistant = messages.find((message) => message.type === 'assistant')
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') return
    expect(assistant.status).toBe('failed')
    expect(assistant.error).toBe('测试失败')
    expect(assistant.codingReport).toMatchObject({
      changedFiles: ['src/failed.ts'],
      pendingBackground: false,
    })
  })

  test('keeps an interim coding report when failure and cancellation events omit it', () => {
    for (const terminalEvent of [
      event({ type: 'run.failed', runId: 'run-terminal', error: { code: 'runtime_error', message: '失败' } }),
      event({ type: 'run.cancelled', runId: 'run-terminal', reason: '已取消' }),
    ]) {
      const messages = projectRuntimeEventMessages([
        event({ type: 'run.started', runId: 'run-terminal' }),
        event({ type: 'assistant.delta', runId: 'run-terminal', delta: '已经修改文件' }),
        event({
          type: 'coding.report.updated',
          runId: 'run-terminal',
          codingReport: {
            status: 'unverified',
            workspaceChanged: true,
            changedFiles: ['src/interim.ts'],
            externalChangedFiles: [],
            pendingBackground: false,
          },
        }),
        terminalEvent,
      ])

      const assistant = messages.find((message) => message.type === 'assistant')
      expect(assistant?.type).toBe('assistant')
      if (assistant?.type !== 'assistant') continue
      expect(assistant.status).toBe('failed')
      expect(assistant.codingReport?.changedFiles).toEqual(['src/interim.ts'])
    }
  })

  test('does not attach an older background result to the active assistant', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started', runId: 'run-old' }),
      event({ type: 'assistant.delta', runId: 'run-old', delta: '旧任务' }),
      event({
        type: 'run.completed',
        runId: 'run-old',
        codingReport: {
          status: 'unverified',
          workspaceChanged: true,
          changedFiles: ['src/old.ts'],
          externalChangedFiles: [],
          pendingBackground: true,
        },
      }),
      event({ type: 'message.user.submitted', runId: 'run-new', text: '新任务', messageId: 'user-new' }),
      event({ type: 'run.started', runId: 'run-new' }),
      event({ type: 'assistant.delta', runId: 'run-new', delta: '处理中' }),
      event({
        type: 'coding.report.updated',
        runId: 'run-old',
        codingReport: {
          status: 'verified',
          workspaceChanged: true,
          changedFiles: ['src/old.ts'],
          externalChangedFiles: [],
          pendingBackground: false,
        },
      }),
    ])

    const assistants = messages.filter((message) => message.type === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.type === 'assistant' ? assistants[0].codingReport : undefined).toMatchObject({
      status: 'verified',
      pendingBackground: false,
    })
    expect(assistants[1]?.type === 'assistant' ? assistants[1].codingReport : undefined).toBeUndefined()
  })

  test('trailing memory context after early run close does not duplicate the assistant message', () => {
    // CDP 实测(2026-08-15 总线批次1 验收):flag on 时同一 run 双路时序为
    //   assistant.final(总线,.155)→ run.completed(总线,.167,flush assistant:<runId>)
    //   → memory.context.used(旧路 replay,.452)→ run.completed(旧路 replay,.880)
    // 总线 run.end 先关流,旧路尾巴 memory.context.used 若经 ??= 重建同 id 空
    // assistant,末尾 flush 会产出第二条 assistant:<runId> → AgentMessages
    // duplicate key(runtime-event-assistant:<uuid>)与空白 assistant 消息。
    const sidecarRun = 'a745e511-sidecar'
    const busRun = 'e5eabd0d-bus'
    const persisted = [
      event({ id: `${sidecarRun}:run.started`, type: 'run.started', runId: sidecarRun, createdAt: '2026-08-15T21:02:05.700Z' }),
      event({ id: `${sidecarRun}:message.user.submitted`, type: 'message.user.submitted', runId: sidecarRun, text: '你有什么能力', createdAt: '2026-08-15T21:02:05.700Z' }),
      event({ id: `${sidecarRun}:item-1:assistant.delta:0`, type: 'assistant.delta', runId: sidecarRun, delta: '回复内容', messageId: 'item-1', createdAt: '2026-08-15T21:02:11.155Z' }),
      event({
        id: `${sidecarRun}:item-mem:memory.context.used`,
        type: 'memory.context.used',
        runId: sidecarRun,
        createdAt: '2026-08-15T21:02:11.452Z',
        items: [{ kind: 'fact', scope: 'workspace', status: 'active', id: 'mem-1', citation: 'memory.md', reason: '相关' }],
      }),
      event({ id: `${sidecarRun}:run.completed`, type: 'run.completed', runId: sidecarRun, createdAt: '2026-08-15T21:02:11.880Z' }),
    ]
    const live = [
      event({ id: 'lifecycle:326:assistant.delta', type: 'assistant.delta', runId: busRun, delta: '回复', createdAt: '2026-08-15T21:02:07.100Z' }),
      event({ id: 'lifecycle:327:assistant.delta', type: 'assistant.delta', runId: busRun, delta: '内容', createdAt: '2026-08-15T21:02:09.000Z' }),
      event({ id: 'lifecycle:555:assistant.final', type: 'assistant.final', runId: busRun, blocks: [{ type: 'text', text: '回复内容' }], createdAt: '2026-08-15T21:02:11.155Z' }),
      event({ id: 'lifecycle:557:run.completed', type: 'run.completed', runId: busRun, createdAt: '2026-08-15T21:02:11.167Z' }),
    ]
    const merged = hydrateRuntimeEvents(
      { 'thread-1': { events: live, updatedAt: 0 } },
      { threadId: 'thread-1', events: persisted },
    )
    const messages = projectRuntimeEventMessages(merged['thread-1']!.events)

    const ids = messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id === `assistant:${sidecarRun}`)).toHaveLength(1)
  })

  test('runId 统一后(批次5 T6):终态后 memory 尾巴与已 flush assistant 同域,分支防线拦截不重建', () => {
    // T6 后总线骨架事件弃自产 UUID、恒用 Lume runId——live 总线侧
    // assistant.final→run.completed 与紧随其后的 memory.context.used(第二入口,
    // tee 排空后才 publish)同 runId。T7c 入口闸门退役,memory.context.used 分支
    // 内 terminalClosed 早退保留为最小防线(历史回放仍可能终态后到达)。
    const runId = 'unified-run-1'
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', runId, text: 'hi', messageId: 'user-1' }),
      event({ id: `lifecycle:10:assistant.delta`, type: 'assistant.delta', runId, delta: 'done' }),
      event({ id: `lifecycle:11:assistant.final`, type: 'assistant.final', runId, blocks: [{ type: 'text', text: 'done' }] }),
      event({ id: `lifecycle:12:run.completed`, type: 'run.completed', runId }),
      // 尾巴:同 runId 的 memory.context.used(终态后到达)
      event({
        id: `lifecycle:13:memory.context.used`,
        type: 'memory.context.used',
        runId,
        items: [{ kind: 'fact', scope: 'workspace', status: 'active', id: 'mem-1', citation: 'memory.md', reason: '相关' }],
      }),
    ])

    // 当前行为保持:分支防线拦截,不重建 assistant——id 唯一、数量不变
    const ids = messages.map((message) => message.id)
    expect(ids).toEqual(['user-1', `assistant:${runId}`])
    expect(new Set(ids).size).toBe(ids.length)
    // 同域验证:尾巴事件 runId 与已 flush assistant 的 runId 一致(收窄前置条件成立)
    expect(ids).toContain(`assistant:${runId}`)
  })

  test('other rebuilding event types after a terminal run do not recreate the flushed assistant', () => {
    // T7c 入口闸门(TERMINAL_REBUILDING_EVENT_TYPES)退役后,这些类型由
    // applyRuntimeEvent 中段的 terminalClosed 通用早退兜底:任何重建型事件
    // (plan.preview 等)终态后到达都不得经 ??= 重建同 id assistant——
    // 消息 id 唯一、数量不变。
    const messages = projectRuntimeEventMessages([
      event({ type: 'message.user.submitted', text: 'hi', messageId: 'user-1' }),
      event({ type: 'assistant.delta', delta: 'done' }),
      event({ type: 'run.completed' }),
      event({
        type: 'plan.preview',
        contractId: 'plan-late',
        title: 'Late plan',
        summary: 'late',
        markdown: '# late',
        stepCount: 1,
      } as any),
      event({ type: 'run.completed' }),
    ])
    const ids = messages.map((message) => message.id)
    expect(ids).toEqual(['user-1', 'assistant:run-1'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('tool.output 快照写入运行中卡片并随 completed 整体清除', () => {
    const messages = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: { command: 'bun test' } }),
      event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'tail v1\n' }),
      event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'tail v1\ntail v2\n' }),
    ])

    const assistant = messages.find((message) => message.type === 'assistant') as Extract<RuntimeMessageView, { type: 'assistant' }>
    const block = assistant.blocks.find((candidate) => candidate.type === 'tool_call') as Extract<typeof assistant.blocks[number], { type: 'tool_call' }>
    expect(block.toolCall.status).toBe('running')
    expect(block.toolCall.streamedOutput).toBe('tail v1\ntail v2\n')

    const finished = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: { command: 'bun test' } }),
      event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'tail v2\n' }),
      event({ type: 'tool.completed', toolCallId: 'tool-1', toolName: 'Bash', resultPreview: 'all output' }),
    ])
    const doneAssistant = finished.find((message) => message.type === 'assistant') as Extract<RuntimeMessageView, { type: 'assistant' }>
    const doneBlock = doneAssistant.blocks.find((candidate) => candidate.type === 'tool_call') as Extract<typeof doneAssistant.blocks[number], { type: 'tool_call' }>
    expect(doneBlock.toolCall.status).toBe('completed')
    expect(doneBlock.toolCall.streamedOutput).toBeUndefined()
    expect(doneBlock.toolCall.output).toBe('all output')
  })

  test('迟到的 tool.output 不复活已结束的卡片，也不凭空建卡', () => {
    const afterCompletion = projectRuntimeEventMessages([
      event({ type: 'run.started' }),
      event({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash', inputPreview: {} }),
      event({ type: 'tool.completed', toolCallId: 'tool-1', toolName: 'Bash', resultPreview: 'done' }),
      event({ id: 'run-1:tool-output:tool-1', type: 'tool.output', toolCallId: 'tool-1', chunk: 'late snapshot' }),
    ])
    const assistant = afterCompletion.find((message) => message.type === 'assistant') as Extract<RuntimeMessageView, { type: 'assistant' }>
    const block = assistant.blocks.find((candidate) => candidate.type === 'tool_call') as Extract<typeof assistant.blocks[number], { type: 'tool_call' }>
    expect(block.toolCall.streamedOutput).toBeUndefined()

    // 无卡片的孤儿快照：不产生任何 assistant
    const orphan = projectRuntimeEventMessages([
      event({ id: 'run-1:tool-output:ghost', type: 'tool.output', toolCallId: 'ghost', chunk: 'x' }),
    ])
    expect(orphan.find((message) => message.type === 'assistant')).toBeUndefined()
  })
})
