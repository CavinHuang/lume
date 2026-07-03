import { describe, expect, test } from 'bun:test'
import { threadToMarkdown } from './thread-to-markdown'
import type { AgentThreadMessage } from '@lume/shared'

function msg(id: string, role: AgentThreadMessage['role'], content: string): AgentThreadMessage {
  return { id, role, content, createdAt: 0 } as AgentThreadMessage
}

describe('threadToMarkdown', () => {
  test('空会话只返回标题', () => {
    expect(threadToMarkdown('我的会话', [])).toBe('# 我的会话')
  })

  test('user 与 assistant 交替拼接', () => {
    const out = threadToMarkdown('T', [
      msg('1', 'user', '你好'),
      msg('2', 'assistant', '有何可以帮你？'),
    ])
    expect(out).toBe('# T\n\n## 👤 用户\n\n你好\n\n## 🤖 助手\n\n有何可以帮你？')
  })

  test('空 content 的消息被跳过', () => {
    const out = threadToMarkdown('T', [msg('1', 'user', '   '), msg('2', 'assistant', '有效')])
    expect(out).toBe('# T\n\n## 🤖 助手\n\n有效')
  })

  test('tool 角色使用工具标签', () => {
    const out = threadToMarkdown('T', [msg('1', 'tool', '读取文件')])
    expect(out).toContain('## 🔧 工具')
    expect(out).toContain('读取文件')
  })

  test('空标题使用兜底文案', () => {
    expect(threadToMarkdown('', [msg('1', 'user', 'hi')])).toContain('# 未命名会话')
  })
})
