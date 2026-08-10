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
    expect(html).toContain('class="island-expanded"')
    expect(html).toContain('island-window-drag-handle island-drag-handle')
    expect(html).not.toContain('island-expanded island-drag-handle')
    expect(html).not.toContain('island-expanded-head island-drag-handle')
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
  test('expanded 有 open-main 与 dismiss 按钮(attention=true)', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({
        presentation: 'expanded',
        sessions: [{
          threadId: 't1', title: '任务A', phase: 'needs-interaction', detail: '',
          activityLines: [], attention: true, unread: false, terminalAt: null, lastActivityAt: 1,
        }],
      })} onIntent={noop} />,
    )
    expect(html).toContain('打开 Lume')
    expect(html).toContain('关闭')
  })
  test('expanded 在 attention=false 时不显示 dismiss', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={state({ presentation: 'expanded' })} onIntent={noop} />,
    )
    expect(html).toContain('打开 Lume')
    expect(html).not.toContain('关闭')
  })
  test('expanded 渲染 planning 两列', () => {
    const planningState: AgentIslandState = {
      presentation: 'expanded',
      primarySessionId: 't1',
      compactLabel: 'Lume · 正在执行',
      sessions: [{
        threadId: 't1', title: 'A', phase: 'running', detail: '', activityLines: [],
        attention: false, unread: false, terminalAt: null, lastActivityAt: 1,
      }],
      planning: {
        todos: [{ id: 'p1', title: '写文档', kind: 'todo', dueAt: 1, overdue: true }],
        reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: 2, overdue: false }],
      },
      updatedAt: 1,
    }
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={planningState} onIntent={noop} />,
    )
    expect(html).toContain('待办')
    expect(html).toContain('提醒')
    expect(html).toContain('data-overdue="true"')
  })
})
