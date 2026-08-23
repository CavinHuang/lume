import { describe, expect, test } from 'bun:test'
import {
  AGENT_ROLE_ASSETS,
  buildAgentRoleMetrics,
  buildAgentRoleRecommendationPreview,
  filterAgentRoles,
} from './agents-settings-state'

describe('agents settings state', () => {
  test('metrics summarize built-in role capabilities', () => {
    expect(buildAgentRoleMetrics().map((item) => [item.label, item.value])).toEqual([
      ['内置角色', '13'],
      ['只读角色', '6'],
      ['后台运行', '6'],
      ['可写角色', '7'],
    ])
  })

  test('filters by Chinese display name, role id and skill name', () => {
    expect(filterAgentRoles('沈策').map((role) => role.id)).toEqual(['planner'])
    expect(filterAgentRoles('林澄').map((role) => role.id)).toEqual(['designer'])
    expect(filterAgentRoles('developer').map((role) => role.id)).toEqual(['developer'])
    expect(filterAgentRoles('agent-novelist').map((role) => role.id)).toEqual(['novelist'])
  })

  test('recommendation preview includes labels and matched keywords', () => {
    expect(buildAgentRoleRecommendationPreview('做一个 PPT dashboard 数据可视化页面').map((item) => ({
      id: item.role.id,
      label: item.label,
      matchedKeywords: item.matchedKeywords,
    })).slice(0, 2)).toEqual([{
      id: 'designer',
      label: '林澄 · 设计工程师',
      matchedKeywords: ['页面', 'PPT', '可视化', 'dashboard'],
    }, {
      id: 'analyst',
      label: '唐栩 · 分析师',
      matchedKeywords: ['数据', '可视化'],
    }])
  })

  test('assets expose a project image for every role and team banner', () => {
    expect(AGENT_ROLE_ASSETS.team).toContain('agents-team')
    expect(Object.keys(AGENT_ROLE_ASSETS.roles).sort()).toEqual([
      'analyst',
      'artist',
      'code-reviewer',
      'designer',
      'developer',
      'explorer',
      'novelist',
      'planner',
      'quant',
      'researcher',
      'translator',
      'voice',
      'writer',
    ])
  })
})
