import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import { AgentMessageQueueList } from './AgentMessageQueueList'

function snapshotWith(items: Array<Partial<AgentMessageQueueSnapshot['queuedMessages'][number]>>): AgentMessageQueueSnapshot {
  return {
    threadId: 't1', revision: 1,
    queuedMessages: items.map((item, i) => ({
      id: `q${i}`, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
      ...item,
    })) as never,
    pendingGuidance: [],
  }
}

// onReorder 新签名:orderedIds。SSR 下无真实拖拽,断言渲染即可。
const noopReorder = () => undefined

describe('AgentMessageQueueList 契约(平铺浮层)', () => {
  test('平铺:无需展开直接渲染行文本', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('排队中')
    expect(html).not.toContain('ChevronRight') // 无折叠头部
  })

  test('blocked 行渲染重试按钮 + 警告图标', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-b', text: '失败的消息', status: 'blocked', blockedReason: '校验失败' }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('重试')
  })

  test('interrupted 时渲染 Resume 横幅', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        interrupted onResume={() => undefined}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('队列已暂停')
    expect(html).toContain('继续')
  })

  test('富 steer 行引导按钮可点(非 disabled)', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '改这里' }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    const m = html.match(/<button[^>]*>[\s\S]*?引导<\/button>/)
    expect(m, '应渲染引导按钮').toBeTruthy()
    expect(m![0]).not.toMatch(/\sdisabled=/)
  })

  test('空队列(无 queued 无 guidance)不渲染', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={{ threadId: 't1', revision: 1, queuedMessages: [], pendingGuidance: [] }}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toBe('')
  })

  test('无文本多类型附件行渲染联合计数', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{
          id: 'q-multi', text: '',
          messageAttachments: [
            { id: 'f1', filename: 'a.txt', mediaType: 'text/plain' } as never,
            { id: 'f2', filename: 'b.txt', mediaType: 'text/plain' } as never,
          ],
          commentAttachments: [{ id: 'c1' } as never],
        }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('2 文件 · 1 评论')
  })
})
