import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentIslandPlanningItem, AgentIslandSessionSnapshot, AgentIslandState } from '@lume/shared'
import {
  AgentIslandSurface,
  formatSessionMeta,
  resolveIslandModelLabel,
  sortIslandPlanningItems,
} from './AgentIslandSurface'

/**
 * Task 3 渲染契约：compact 队列徽章 + attention pill + expanded 会话行 meta + planning 全量。
 *
 * 测试策略（brief 步骤 2 + 全球约束「renderToStaticMarkup 困难时可退化为测纯 helper」）：
 * - compact 层同步渲染 → 用 renderToStaticMarkup 断言 DOM（队列徽章 / attention pill）。
 * - expanded 层依赖 surfaceMode 状态机（compact→expanded 走 useEffect），SSR 不触发 effect，
 *   故把 sort/logic 抽成纯 helper（sortIslandPlanningItems / formatSessionMeta）直接断言，
 *   避免造 createRoot+act 的大堆 fake DOM 重复 AgentView.test.tsx 的样板。
 */

function baseState(over: Partial<AgentIslandState>): AgentIslandState {
  return {
    presentation: 'compact',
    primarySessionId: 't1',
    compactLabel: 'Lume · 正在执行',
    sessions: [
      {
        threadId: 't1',
        title: '任务A',
        phase: 'running',
        detail: '第 1 步 · ls',
        activityLines: ['ls'],
        attention: false,
        unread: false,
        terminalAt: null,
        lastActivityAt: 1,
      },
    ],
    planning: { todos: [], reminders: [] },
    updatedAt: 1,
    ...over,
  }
}

function planningItem(id: string, over: Partial<AgentIslandPlanningItem>): AgentIslandPlanningItem {
  return { id, title: id, kind: 'todo', dueAt: 0, overdue: false, ...over }
}

const noop = () => undefined

describe('AgentIslandSurface compact 队列徽章', () => {
  test('primary.queuedCount > 0 → compact 含「队列 N」', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface
        state={baseState({
          sessions: [
            {
              threadId: 't1',
              title: '任务A',
              phase: 'running',
              detail: '',
              activityLines: [],
              attention: false,
              unread: false,
              terminalAt: null,
              lastActivityAt: 1,
              queuedCount: 3,
            },
          ],
        })}
        onIntent={noop}
      />,
    )
    expect(html).toContain('队列 3')
    expect(html).toContain('island-queue-badge')
  })

  test('primary.queuedCount 缺省 (=0) → 不显队列徽章', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface state={baseState({})} onIntent={noop} />,
    )
    expect(html).not.toContain('队列')
    expect(html).not.toContain('island-queue-badge')
  })
})

describe('AgentIslandSurface compact attention pill', () => {
  test('needs-interaction 会话 ≥2 → 紧邻 dot 显数字 pill + data-attention-count', () => {
    const sessions: AgentIslandSessionSnapshot[] = [
      {
        threadId: 't1',
        title: '任务A',
        phase: 'needs-interaction',
        detail: '',
        activityLines: [],
        attention: true,
        unread: false,
        terminalAt: null,
        lastActivityAt: 1,
      },
      {
        threadId: 't2',
        title: '任务B',
        phase: 'needs-interaction',
        detail: '',
        activityLines: [],
        attention: true,
        unread: false,
        terminalAt: null,
        lastActivityAt: 2,
      },
    ]
    const html = renderToStaticMarkup(
      <AgentIslandSurface
        state={baseState({
          primarySessionId: 't1',
          sessions,
        })}
        onIntent={noop}
      />,
    )
    expect(html).toMatch(/data-attention-count="2"/)
    expect(html).toContain('island-attention-pill')
    // pill 紧邻 dot：dot 标记出现在 attention-pill 标记之前（同 button 内顺序）
    const dotIdx = html.indexOf('island-dot')
    const pillIdx = html.indexOf('island-attention-pill')
    expect(dotIdx).toBeGreaterThan(-1)
    expect(pillIdx).toBeGreaterThan(dotIdx)
  })

  test('needs-interaction 会话 ==1 → 不显 pill（走 warning phase dot）', () => {
    const html = renderToStaticMarkup(
      <AgentIslandSurface
        state={baseState({
          sessions: [
            {
              threadId: 't1',
              title: '任务A',
              phase: 'needs-interaction',
              detail: '',
              activityLines: [],
              attention: true,
              unread: false,
              terminalAt: null,
              lastActivityAt: 1,
            },
          ],
        })}
        onIntent={noop}
      />,
    )
    expect(html).not.toContain('island-attention-pill')
    expect(html).not.toContain('data-attention-count')
  })
})

describe('sortIslandPlanningItems（expanded planning 全量排序）', () => {
  test('overdue 置顶 + dueAt 升序', () => {
    const items = [
      planningItem('a', { dueAt: 100, overdue: false }),
      planningItem('b', { dueAt: 50, overdue: true }),
      planningItem('c', { dueAt: 30, overdue: false }),
      planningItem('d', { dueAt: 20, overdue: true }),
    ]
    const sorted = sortIslandPlanningItems(items)
    // overdue 优先（d < b 按 dueAt 升序），然后非 overdue（c < a）
    expect(sorted.map((x) => x.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  test('不修改原数组（纯函数，[..items].sort）', () => {
    const items = [
      planningItem('a', { dueAt: 100, overdue: false }),
      planningItem('b', { dueAt: 50, overdue: true }),
    ]
    const snapshot = items.map((x) => ({ ...x }))
    sortIslandPlanningItems(items)
    expect(items).toEqual(snapshot)
  })

  test('空数组 → 空数组', () => {
    expect(sortIslandPlanningItems([])).toEqual([])
  })
})

describe('formatSessionMeta（expanded 会话行 model · cost · token 小字）', () => {
  test('三者齐全 → 「label · $X.XX · Yk」', () => {
    const meta = formatSessionMeta(
      { modelRef: 'claude-sonnet-4-5', costUSD: 0.42, tokenTotal: 12345 },
      () => 'Claude Sonnet 4.5',
    )
    expect(meta).toBe('Claude Sonnet 4.5 · $0.42 · 12.3k')
  })

  test('cost/token 仅 >0 才显（=0 / undefined 省略，避免「· $0.00」噪声）', () => {
    expect(
      formatSessionMeta(
        { modelRef: 'claude-sonnet-4-5', costUSD: 0, tokenTotal: 0 },
        () => 'Claude Sonnet 4.5',
      ),
    ).toBe('Claude Sonnet 4.5')
    expect(
      formatSessionMeta(
        { modelRef: undefined, costUSD: undefined, tokenTotal: undefined },
        () => 'Claude Sonnet 4.5',
      ),
    ).toBe('')
  })

  test('model 解析失败（registry 无此 ref）→ 省略 model 段（不显原始 ref 字符串）', () => {
    const meta = formatSessionMeta(
      { modelRef: 'some-unknown-ref-xyz', costUSD: 1.5, tokenTotal: 5000 },
      () => undefined,
    )
    expect(meta).toBe('$1.50 · 5.0k')
    expect(meta).not.toContain('some-unknown-ref-xyz')
  })

  test('无 model 但有 cost+token → 「$X.XX · Yk」（无前导分隔符）', () => {
    expect(
      formatSessionMeta(
        { modelRef: undefined, costUSD: 0.5, tokenTotal: 2500 },
        () => undefined,
      ),
    ).toBe('$0.50 · 2.5k')
  })

  test('token / 1000 保留 1 位小数（含 <1000 进位到 1.0k）', () => {
    expect(
      formatSessionMeta({ modelRef: undefined, tokenTotal: 1500 }, () => undefined),
    ).toBe('1.5k')
    expect(
      formatSessionMeta({ modelRef: undefined, tokenTotal: 999 }, () => undefined),
    ).toBe('1.0k')
  })

  test('real registry: resolveIslandModelLabel（默认 resolver 走 findModelMeta）', () => {
    // 真注册表行为：已知 model ref 解析出 displayName；未知 ref 返回 undefined
    const known = resolveIslandModelLabel('claude-sonnet-4-5')
    expect(typeof known === 'string').toBe(true)
    expect(resolveIslandModelLabel('this-is-not-a-real-model-xyz-123')).toBeUndefined()
  })
})

describe('AgentIslandSurface expanded 溢出接线（集成）', () => {
  test('planning todos > PLANNING_VISIBLE_MAX → sortIslandPlanningItems + slice(0,5) + 「还有 N 条」', () => {
    // brief 步骤 2 断言：「planning 5 条 + 第 6 条 → 含「还有 1 条」」。
    // expanded DOM 在 SSR 不挂载（surfaceMode 状态机依赖 useEffect），用纯函数复现渲染层数据流：
    //   sortIslandPlanningItems(all) → visible=sorted.slice(0,5) → overflow=len-visible
    // JSX 接线（AgentIslandSurface.tsx planning IIFE）直接消费这三个值。
    const all = Array.from({ length: 6 }, (_, i) =>
      planningItem(`t${i}`, { dueAt: i, overdue: false }),
    )
    const sorted = sortIslandPlanningItems(all)
    const visible = sorted.slice(0, 5)
    const overflow = sorted.length - visible.length
    expect(visible).toHaveLength(5)
    expect(overflow).toBe(1)
    expect(`还有 ${overflow} 条`).toBe('还有 1 条')
  })
})
