import { describe, expect, test } from 'bun:test'
import { resolveSubagentRoleDisplay } from './subagent-role-display'

describe('resolveSubagentRoleDisplay', () => {
  test('known role id displays built-in role identity and badges', () => {
    expect(resolveSubagentRoleDisplay({ agentType: 'designer' })).toEqual({
      knownRole: true,
      primaryLabel: '林澄 · 设计工程师',
      runtimeId: 'designer',
      badges: ['可写', '前台', 'agent-designer'],
    })
  })

  test('resolved agent id wins over requested agent id', () => {
    expect(resolveSubagentRoleDisplay({
      agentType: 'general-purpose',
      requestedAgentId: 'designer',
      resolvedAgentId: 'developer',
    })).toMatchObject({
      knownRole: true,
      primaryLabel: '祁远 · 开发者',
      runtimeId: 'developer',
    })
  })

  test('unknown agent keeps fallback display', () => {
    expect(resolveSubagentRoleDisplay({
      agentType: 'custom-editor',
      label: 'Custom editing run',
    })).toEqual({
      knownRole: false,
      primaryLabel: 'Custom editing run',
      runtimeId: 'custom-editor',
      badges: [],
    })
  })
})
