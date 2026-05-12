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
})
