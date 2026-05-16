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
      toolCalls: [],
    }])
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
})
