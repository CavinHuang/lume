import { describe, expect, test } from 'bun:test'
import type { AgentThreadMeta } from '@lume/shared'
import {
  buildWelcomeSurfaceViewModel,
  PRIMARY_WELCOME_CARD_IDS,
  RECENT_FILE_PANEL_ROWS,
  RECENT_THREAD_PANEL_LIMIT,
  RECOMMENDED_WORKFLOW_PANEL_ROWS,
} from './welcome-surface-view-model'

function createThread(index: number, overrides: Partial<AgentThreadMeta> = {}): AgentThreadMeta {
  const updatedAt = 1_000_000 + index * 1_000

  return {
    id: `thread-${index}`,
    title: `欢迎页线程 ${index}`,
    workspaceId: 'workspace-1',
    pinned: false,
    createdAt: updatedAt - 500,
    updatedAt,
    ...overrides,
  }
}

describe('buildWelcomeSurfaceViewModel', () => {
  test('keeps the full workspace name in the hero subtitle for workspace-aware copy', () => {
    const workspaceName = 'Lume 主路径欢迎界面视觉定稿工作区 - 包含一个足够长的名称用于验证不会被截断'
    const model = buildWelcomeSurfaceViewModel({
      workspaceName,
      recentThreads: [],
      recentFiles: [],
    })

    expect(model.hero.title).toBe('今天想一起完成什么？')
    expect(model.hero.subtitle).toContain(workspaceName)
  })

  test('always returns four primary cards in the approved stable order', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
      recentThreads: [],
      recentFiles: [],
    })

    expect(model.primaryCards).toHaveLength(4)
    expect(model.primaryCards.map((card) => card.id)).toEqual(PRIMARY_WELCOME_CARD_IDS)
  })

  test('limits recent threads to the designed panel size and sorts by recency', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: 'Lume 主路径',
      recentThreads: [
        createThread(1),
        createThread(6),
        createThread(3),
        createThread(5),
        createThread(4),
        createThread(2),
      ],
      recentFiles: [],
    })

    const recentThreadsPanel = model.lowerPanels[0]

    expect(recentThreadsPanel.id).toBe('recent-threads')
    expect(recentThreadsPanel.items).toHaveLength(RECENT_THREAD_PANEL_LIMIT)
    expect(recentThreadsPanel.items.map((item) => item.id)).toEqual([
      'thread-6',
      'thread-5',
      'thread-4',
      'thread-3',
    ])
  })

  test('returns a stable lower-panel structure with empty-state-friendly rows when data is sparse', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: null,
      recentThreads: [],
      recentFiles: [],
    })

    expect(model.lowerPanels.map((panel) => panel.id)).toEqual([
      'recent-threads',
      'recommended-workflows',
      'recent-files',
    ])

    expect(model.lowerPanels[1].items).toHaveLength(RECOMMENDED_WORKFLOW_PANEL_ROWS)
    expect(model.lowerPanels[2].items).toHaveLength(RECENT_FILE_PANEL_ROWS)
    expect(model.lowerPanels[2].items.every((item) => item.kind === 'empty')).toBe(true)
  })
})
