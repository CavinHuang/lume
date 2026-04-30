import { describe, expect, test } from 'bun:test'
import { projectRunEventMessages } from './run-event-message-projection'
import type { LumeRunEvent } from '@lume/shared'

describe('run-event-message-projection', () => {
  test('aggregates assistant deltas and tool lifecycle into one live assistant message', () => {
    const events: LumeRunEvent[] = [
      { type: 'user_message_submitted', text: 'hi', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_thinking_delta', text: 'thinking...' },
      { type: 'assistant_delta', text: 'hello ' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Bash',
          input: { command: 'pwd' },
          parentAgentId: 'runtime-core',
          status: 'running',
          createdAt: '2026-04-30T00:00:00.000Z',
        },
      },
      {
        type: 'tool_call_completed',
        item: {
          type: 'tool_result',
          id: 'tool-1-result',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          output: 'ok',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      },
      { type: 'assistant_delta', text: 'world' },
    ]

    expect(projectRunEventMessages(events)).toEqual([{
      id: 'user:2026-04-30T00:00:00.000Z',
      type: 'user',
      text: 'hi',
    }, {
      id: 'assistant:2026-04-30T00:00:00.000Z',
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
      status: 'streaming',
      toolCalls: [{
        id: 'tool-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
        status: 'completed',
        output: 'ok',
        isError: false,
      }],
    }])
  })

  test('marks failed terminal state without dropping accumulated text', () => {
    expect(projectRunEventMessages([
      { type: 'assistant_delta', text: 'before failure' },
      { type: 'run_failed', error: { code: 'runtime_error', message: 'boom' } },
    ])).toEqual([{
      id: 'assistant:0',
      type: 'assistant',
      text: 'before failure',
      thinking: '',
      blocks: [{ type: 'text', id: 'text:0', text: 'before failure' }],
      status: 'failed',
      error: 'boom',
      toolCalls: [],
    }])
  })

  test('creates an immediate assistant placeholder after a submitted user message', () => {
    expect(projectRunEventMessages([
      { type: 'user_message_submitted', text: 'start', createdAt: '2026-04-30T00:00:00.000Z' },
    ])).toEqual([
      {
        id: 'user:2026-04-30T00:00:00.000Z',
        type: 'user',
        text: 'start',
      },
      {
        id: 'assistant:2026-04-30T00:00:00.000Z',
        type: 'assistant',
        text: '',
        thinking: '',
        blocks: [],
        status: 'streaming',
        toolCalls: [],
      },
    ])
  })

  test('segments multiple user turns instead of merging assistant output', () => {
    const messages = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'first', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: 'one' },
      { type: 'run_completed', result: { status: 'completed' } },
      { type: 'user_message_submitted', text: 'second', createdAt: '2026-04-30T00:01:00.000Z' },
      { type: 'assistant_delta', text: 'two' },
    ])

    expect(messages.map((message) => ({ type: message.type, text: message.text }))).toEqual([
      { type: 'user', text: 'first' },
      { type: 'assistant', text: 'one' },
      { type: 'user', text: 'second' },
      { type: 'assistant', text: 'two' },
    ])
  })

  test('preserves arrival order across text and thinking blocks', () => {
    const [, assistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'ordered', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: 'before ' },
      { type: 'assistant_thinking_delta', text: 'think ' },
      { type: 'assistant_delta', text: 'after' },
      { type: 'assistant_thinking_delta', text: 'more thinking' },
    ])

    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(assistant.blocks).toEqual([
      { type: 'text', id: 'text:0', text: 'before ' },
      { type: 'thinking', id: 'thinking:1', text: 'think ' },
      { type: 'text', id: 'text:2', text: 'after' },
      { type: 'thinking', id: 'thinking:3', text: 'more thinking' },
    ])
  })

  test('uses final assistant markdown as the canonical completed content', () => {
    const [, assistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'format list', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: '- first- second' },
      {
        type: 'assistant_message_final',
        blocks: [{ type: 'text', text: '- first\n- second' }],
      },
      { type: 'run_completed', result: { status: 'completed' } },
    ])

    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(assistant.text).toBe('- first\n- second')
    expect(assistant.blocks).toEqual([
      { type: 'text', id: 'text:0', text: '- first\n- second' },
    ])
  })

  test('preserves streamed thinking when final assistant message only contains public text', () => {
    const [, assistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'write', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_thinking_delta', text: '先构思故事，再写文件。' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Write',
          input: { file_path: '故事.md' },
          parentAgentId: 'runtime-core',
          status: 'running',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      },
      {
        type: 'assistant_message_final',
        blocks: [{ type: 'text', text: '写好了。' }],
      },
      { type: 'run_completed', result: { status: 'completed' } },
    ])

    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(assistant.thinking).toBe('先构思故事，再写文件。')
    expect(assistant.blocks.map((block) => block.type)).toEqual(['thinking', 'tool_call', 'text'])
  })

  test('applies final assistant markdown before completion so live and refreshed rendering match', () => {
    const [, streamingAssistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'format list', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: '- first- second' },
      {
        type: 'assistant_message_final',
        blocks: [{ type: 'text', text: '- first\n- second' }],
      },
    ])

    expect(streamingAssistant?.type).toBe('assistant')
    if (streamingAssistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(streamingAssistant.status).toBe('streaming')
    expect(streamingAssistant.text).toBe('- first\n- second')
    expect(streamingAssistant.blocks).toEqual([
      { type: 'text', id: 'text:0', text: '- first\n- second' },
    ])

    const [, completedAssistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'format list', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: '- first- second' },
      {
        type: 'assistant_message_final',
        blocks: [{ type: 'text', text: '- first\n- second' }],
      },
      { type: 'run_completed', result: { status: 'completed' } },
    ])

    expect(completedAssistant?.type).toBe('assistant')
    if (completedAssistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(completedAssistant.status).toBe('completed')
    expect(completedAssistant.text).toBe('- first\n- second')
  })

  test('keeps tool blocks before final text when the final answer arrives after tool execution', () => {
    const [, assistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'write file', createdAt: '2026-04-30T00:00:00.000Z' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Write',
          input: { file_path: 'story.txt' },
          parentAgentId: 'runtime-core',
          status: 'running',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      },
      {
        type: 'tool_call_completed',
        item: {
          type: 'tool_result',
          id: 'tool-1-result',
          toolCallId: 'tool-1',
          toolName: 'Write',
          output: 'saved',
          createdAt: '2026-04-30T00:00:02.000Z',
        },
      },
      {
        type: 'assistant_message_final',
        blocks: [{ type: 'text', text: '我已经写好了。' }],
      },
      { type: 'run_completed', result: { status: 'completed' } },
    ])

    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(assistant.blocks.map((block) => block.type)).toEqual(['tool_call', 'text'])
  })

  test('preserves arrival order when a tool call arrives before thinking', () => {
    const [, streamingAssistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'write file', createdAt: '2026-04-30T00:00:00.000Z' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Write',
          input: { file_path: 'story.md' },
          parentAgentId: 'runtime-core',
          status: 'running',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      },
    ])

    expect(streamingAssistant?.type).toBe('assistant')
    if (streamingAssistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(streamingAssistant.blocks.map((block) => block.type)).toEqual(['tool_call'])

    const [, thinkingAssistant] = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'write file', createdAt: '2026-04-30T00:00:00.000Z' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Write',
          input: { file_path: 'story.md' },
          parentAgentId: 'runtime-core',
          status: 'running',
          createdAt: '2026-04-30T00:00:01.000Z',
        },
      },
      { type: 'assistant_thinking_delta', text: '构思故事并写入文件。' },
    ])

    expect(thinkingAssistant?.type).toBe('assistant')
    if (thinkingAssistant?.type !== 'assistant') throw new Error('expected assistant')
    expect(thinkingAssistant.blocks).toMatchObject([
      { type: 'tool_call', id: 'tool:tool-1' },
      { type: 'thinking', id: 'thinking:1', text: '构思故事并写入文件。' },
    ])
  })

  test('ignores late assistant events after terminal state until the next user message', () => {
    const messages = projectRunEventMessages([
      { type: 'user_message_submitted', text: 'one', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: 'done' },
      { type: 'run_completed', result: { status: 'completed' } },
      { type: 'assistant_thinking_delta', text: 'late thinking' },
      { type: 'assistant_delta', text: 'late text' },
      { type: 'user_message_submitted', text: 'two', createdAt: '2026-04-30T00:01:00.000Z' },
      { type: 'assistant_delta', text: 'next' },
    ])

    expect(messages.map((message) => ({ type: message.type, text: message.text }))).toEqual([
      { type: 'user', text: 'one' },
      { type: 'assistant', text: 'done' },
      { type: 'user', text: 'two' },
      { type: 'assistant', text: 'next' },
    ])
  })
})
