import { describe, expect, test } from 'bun:test'
import { buildWelcomeSurfaceViewModel } from './welcome-surface-view-model'

describe('buildWelcomeSurfaceViewModel', () => {
  test('keeps the full workspace name in the hero subtitle for workspace-aware copy', () => {
    const workspaceName = 'Lume 主路径欢迎界面视觉定稿工作区 - 包含一个足够长的名称用于验证不会被截断'
    const model = buildWelcomeSurfaceViewModel({
      workspaceName,
    })

    expect(model.hero.title).toBe('今天想一起完成什么？')
    expect(model.hero.subtitle).toContain(workspaceName)
  })

  test('uses the current workspace fallback when no project is selected', () => {
    const model = buildWelcomeSurfaceViewModel({
      workspaceName: null,
    })

    expect(model.hero.subtitle).toBe('在当前工作区中开始新的工作流')
  })
})
