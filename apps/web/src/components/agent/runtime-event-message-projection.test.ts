import { describe, expect, test } from 'bun:test'
import { projectRuntimeEventMessages, applyRuntimeEventsIncremental, type ProjectionRef } from './runtime-event-message-projection'
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
})
