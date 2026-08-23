import { describe, expect, test } from 'bun:test'
import {
  applyAgentRoleMentions,
  applyAgentRoleRecommendation,
  buildAgentRoleMentionItems,
  buildAgentInputRoleRecommendations,
} from './agent-input-role-recommendations'

describe('agent input role recommendations', () => {
  test('empty input returns no recommendations', () => {
    expect(buildAgentInputRoleRecommendations('')).toEqual([])
    expect(buildAgentInputRoleRecommendations('   \n  ')).toEqual([])
  })

  test('task text returns at most three labeled role recommendations', () => {
    const recommendations = buildAgentInputRoleRecommendations('写一个 PPT dashboard 数据可视化页面')

    expect(recommendations.length).toBeLessThanOrEqual(3)
    expect(recommendations.slice(0, 2).map((item) => item.role.id)).toEqual(['designer', 'analyst'])
    expect(recommendations[0]).toMatchObject({
      label: '林澄 · 设计工程师',
      score: 4,
      matchedKeywords: ['页面', 'PPT', '可视化', 'dashboard'],
    })
  })

  test('role selection prepends a stable native instruction', () => {
    expect(applyAgentRoleRecommendation('做一个首页视觉方案', 'designer')).toBe(
      '请调用 Agent 工具，并将 subagent_type 设置为 "designer" 来处理这个任务：\n做一个首页视觉方案'
    )
  })

  test('role selection does not duplicate the same instruction', () => {
    const text = '请调用 Agent 工具，并将 subagent_type 设置为 "designer" 来处理这个任务：\n做一个首页视觉方案'

    expect(applyAgentRoleRecommendation(text, 'designer')).toBe(text)
  })

  test('@ mention suggestions put matched agents before files', () => {
    const items = buildAgentRoleMentionItems('作家')

    expect(items[0]).toMatchObject({
      id: 'writer',
      label: 'writer',
      type: 'agent',
      title: '江岚 · 作家',
      section: 'agent',
    })
  })

  test('@ agent mention converts to a stable subagent instruction', () => {
    expect(applyAgentRoleMentions('@writer 帮我写一篇公众号文章')).toBe(
      '请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n帮我写一篇公众号文章'
    )
  })

  test('@ agent mention supports display name and removes only the selected mention', () => {
    expect(applyAgentRoleMentions('帮我 @江岚 写一版文案')).toBe(
      '请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n帮我 写一版文案'
    )
  })
})
