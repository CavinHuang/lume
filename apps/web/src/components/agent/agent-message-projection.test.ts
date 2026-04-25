import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@lume/shared'
import { projectRenderableAgentMessages } from './agent-message-projection'

describe('projectRenderableAgentMessages', () => {
  test('projects multiple assistant SDK events after one user message as one visible assistant response', () => {
    const messages = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '看看你的工作区有什么东西' }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need to inspect the workspace.' },
            { type: 'tool_use', id: 'ls-root', name: 'ls', input: { path: '/workspace' } },
          ],
        },
      },
      {
        type: 'tool_result',
        result: { tool_use_id: 'ls-root', tool_name: 'ls', output: '{"entries":["skills"]}' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'ls-skills', name: 'ls', input: { path: '/workspace/skills' } },
          ],
        },
      },
      {
        type: 'tool_result',
        result: { tool_use_id: 'ls-skills', tool_name: 'ls', output: '{"entries":["pdf"]}' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '看了一圈，技能库挺齐全。' }],
        },
      },
    ] as SDKMessage[]

    const projected = projectRenderableAgentMessages(messages)

    expect(projected).toHaveLength(2)
    expect(projected[0]?.type).toBe('user')
    expect(projected[1]?.type).toBe('assistant')
    expect((projected[1] as Extract<SDKMessage, { type: 'assistant' }>).message.content).toEqual([
      { type: 'thinking', thinking: 'Need to inspect the workspace.' },
      { type: 'tool_use', id: 'ls-root', name: 'ls', input: { path: '/workspace' } },
      { type: 'tool_use', id: 'ls-skills', name: 'ls', input: { path: '/workspace/skills' } },
      { type: 'text', text: '看了一圈，技能库挺齐全。' },
    ])
  })
})
