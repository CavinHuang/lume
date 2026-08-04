import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentIslandState } from '@lume/shared'
import { AgentIslandSurface } from './AgentIslandSurface'

function state(over: Partial<AgentIslandState>): AgentIslandState {
  return {
    presentation: 'compact',
    primarySessionId: 't1',
    compactLabel: 'Lume · 正在执行',
    sessions: [{
      threadId: 't1', title: '任务A', phase: 'running', detail: '第 1 步 · ls',
      activityLines: ['ls'], attention: false, unread: false, terminalAt: null, lastActivityAt: 1,
    }],
    planning: { todos: [], reminders: [] },
    updatedAt: 1,
    ...over,
  }
}
const noop = () => undefined

describe('AgentIslandSurface 契约', () => {
  test('compact 渲染 compactLabel + 展开箭头', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({})} onIntent={noop} />,
    )
    expect(html).toContain('Lume · 正在执行')
    expect(html).toMatch(/data-phase="running"/)
  })
  test('expanded 渲染会话标题', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({ presentation: 'expanded' })} onIntent={noop} />,
    )
    expect(html).toContain('任务A')
  })
  test('needs-interaction 渲染"需要你接手"', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({ compactLabel: 'Lume · 需要你接手',
        sessions: [{ threadId: 't1', title: '任务A', phase: 'needs-interaction', detail: '',
          activityLines: [], attention: true, unread: false, terminalAt: null, lastActivityAt: 1 }] })} onIntent={noop} />,
    )
    expect(html).toContain('需要你接手')
    expect(html).toMatch(/data-phase="needs-interaction"/)
  })
})
