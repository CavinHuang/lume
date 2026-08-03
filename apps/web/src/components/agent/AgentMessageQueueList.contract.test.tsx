import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import { AgentMessageQueueList } from './AgentMessageQueueList'

function snapshotWith(items: Array<Partial<AgentMessageQueueSnapshot['queuedMessages'][number]>>): AgentMessageQueueSnapshot {
  return {
    threadId: 't1',
    revision: 1,
    queuedMessages: items.map((item, i) => ({
      id: `q${i}`, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
      ...item,
    })) as never,
    pendingGuidance: [],
  }
}

describe('AgentMessageQueueList 契约', () => {
  test('blocked 行渲染 Retry 按钮', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-blocked', text: '失败的消息', status: 'blocked', blockedReason: '校验失败' }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
        defaultExpanded
      />,
    )
    expect(html).toContain('重试')
  })

  test('无文本的浏览器附件行显示附件摘要', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
        defaultExpanded
      />,
    )
    expect(html).toContain('浏览器注释')
  })

  test('interrupted 时渲染 Resume 横幅', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        interrupted
        onResume={() => undefined}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('队列已暂停')
    expect(html).toContain('继续')
  })

  test('富 steer:带浏览器附件的行引导按钮可点(非 disabled)', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '改这里', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
        defaultExpanded
      />,
    )
    const guidedButtonMatch = html.match(/<button[^>]*>[\s\S]*?引导<\/button>/)
    expect(guidedButtonMatch, '应渲染引导按钮').toBeTruthy()
    // 检测 disabled "属性"（disabled=""），排除 Tailwind class 里的 `disabled:` 前缀
    expect(guidedButtonMatch![0]).not.toMatch(/\sdisabled=/)
  })
})
