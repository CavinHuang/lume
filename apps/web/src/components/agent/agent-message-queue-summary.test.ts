import { describe, expect, test } from 'bun:test'
import type { AgentQueuedMessage } from '@lume/shared'
import { summarizeQueuedMessage } from './agent-message-queue-summary'

function base(over: Partial<AgentQueuedMessage> = {}): AgentQueuedMessage {
  return {
    id: 'q1', threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
    ...over,
  } as AgentQueuedMessage
}

describe('summarizeQueuedMessage', () => {
  test('有文本时直接返回文本', () => {
    expect(summarizeQueuedMessage(base({ text: '改这里' }))).toBe('改这里')
  })
  test('无文本 + 浏览器附件 → 浏览器注释摘要', () => {
    const item = base({
      browserAttachments: [{ id: 'b1' } as never, { id: 'b2' } as never],
    })
    expect(summarizeQueuedMessage(item)).toContain('2')
    expect(summarizeQueuedMessage(item)).toContain('浏览器')
  })
  test('无文本 + 文件附件 → 文件摘要', () => {
    const item = base({ messageAttachments: [{ id: 'f1' } as never] })
    expect(summarizeQueuedMessage(item)).toContain('文件')
  })
  test('无文本无附件 → 占位', () => {
    expect(summarizeQueuedMessage(base())).toBe('（空消息）')
  })
  test('无文本 + 多类型附件 → 联合计数(· 连接)', () => {
    const item = base({
      messageAttachments: [{ id: 'f1' } as never, { id: 'f2' } as never],
      commentAttachments: [{ id: 'c1' } as never],
      browserAttachments: [{ id: 'b1' } as never],
    })
    expect(summarizeQueuedMessage(item)).toBe('2 文件 · 1 评论 · 1 浏览器注释')
  })
  test('无文本 + 仅评论 → 单类型计数', () => {
    const item = base({ commentAttachments: [{ id: 'c1' } as never, { id: 'c2' } as never] })
    expect(summarizeQueuedMessage(item)).toBe('2 评论')
  })
  test('有文本时忽略附件(只返回文本)', () => {
    const item = base({
      text: '改这里',
      messageAttachments: [{ id: 'f1' } as never],
      browserAttachments: [{ id: 'b1' } as never],
    })
    expect(summarizeQueuedMessage(item)).toBe('改这里')
  })
  test('文本含引用 XML 块时剥离 <quoted_context>，只返回纯净文本', () => {
    const quotedBlock = '<quoted_context source="agent-history" label="Agent 历史" message_id="m1" role="assistant">\n引用内容\n</quoted_context>\n\n'
    expect(summarizeQueuedMessage(base({ text: quotedBlock + '改这里' }))).toBe('改这里')
  })
  test('文本只有引用块时，剥离后按空文本降级到占位', () => {
    const quotedBlock = '<quoted_file path="src/a.ts">\n代码\n</quoted_file>\n\n'
    expect(summarizeQueuedMessage(base({ text: quotedBlock }))).toBe('（空消息）')
  })
})
