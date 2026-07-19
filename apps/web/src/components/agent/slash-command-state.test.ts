import { describe, expect, test } from 'bun:test'
import { buildSlashSuggestionItems, getCommonSlashSuggestionItems } from './slash-command-state'

describe('buildSlashSuggestionItems', () => {
  test('returns common slash commands ahead of workspace skills', () => {
    const items = buildSlashSuggestionItems([
      { uri: 'lume-skill://using-superpowers', kind: 'skill', displayName: 'Using Superpowers', description: 'Bootstrap the workflow', source: 'filesystem', scope: 'workspace', callable: true },
      { uri: 'lume-skill://debug', kind: 'skill', displayName: 'Debug', description: 'Investigate runtime failures', source: 'filesystem', scope: 'workspace', callable: true },
    ], '')

    expect(items.slice(0, 2).map((item) => item.title)).toEqual(['/clear', '/compact'])
    expect(items.some((item) => item.uri === 'lume-skill://using-superpowers' && item.section === 'skill')).toBe(true)
  })

  test('filters both quick actions and skills with the same query', () => {
    const items = buildSlashSuggestionItems([
      { uri: 'lume-skill://debug', kind: 'skill', displayName: 'Debug', description: 'Investigate runtime failures', source: 'filesystem', scope: 'workspace', callable: true },
      { uri: 'lume-plugin://review', kind: 'plugin', displayName: 'Review', description: 'Review recent changes', source: 'plugin', scope: 'global-plugin', callable: true },
    ], 'deb')

    expect(items).toEqual([
      expect.objectContaining({ uri: 'lume-skill://debug', section: 'skill' }),
    ])
  })

  test('matches localized command keywords', () => {
    const items = buildSlashSuggestionItems([], '压缩')

    expect(items).toEqual([
      expect.objectContaining({ title: '/compact', section: 'capability' }),
    ])
  })

  test('keeps unavailable capabilities visible with a reason', () => {
    const items = buildSlashSuggestionItems([
      { uri: 'lume-plugin://review', kind: 'plugin', displayName: 'Review', source: 'plugin', scope: 'global-plugin', callable: false, unavailableReason: 'disabled' },
    ], 'review')
    expect(items).toEqual([expect.objectContaining({ disabled: true, disabledReason: '未启用', meta: '未启用' })])
  })

  test('reserves panel capacity for plugins when skills exceed the section limit', () => {
    const skills = Array.from({ length: 14 }, (_, index) => ({
      uri: `lume-skill://skill-${index}`,
      kind: 'skill' as const,
      displayName: `Skill ${index}`,
      source: 'filesystem',
      scope: 'workspace' as const,
      callable: true,
    }))
    const items = buildSlashSuggestionItems([
      ...skills,
      { uri: 'lume-plugin://demo', kind: 'plugin', displayName: 'Demo Plugin', source: 'plugin', scope: 'global-plugin', callable: true },
      { uri: 'lume-skill://demo:review', kind: 'plugin-skill', displayName: 'Review', source: 'plugin', scope: 'global-plugin', callable: true, pluginId: 'demo' },
    ], '')

    expect(items.some((item) => item.uri === 'lume-plugin://demo' && item.section === 'plugin')).toBe(true)
    expect(items.some((item) => item.kind === 'plugin-skill' && item.section === 'plugin')).toBe(true)
  })
})

describe('executeOnSelect 标记', () => {
  test('/clear /compact /reload-plugins 标记为选中即执行', () => {
    const items = getCommonSlashSuggestionItems()
    const clear = items.find((i) => i.id === 'clear')
    const compact = items.find((i) => i.id === 'compact')
    const reload = items.find((i) => i.id === 'reload-plugins')
    expect(clear?.executeOnSelect).toBe(true)
    expect(compact?.executeOnSelect).toBe(true)
    expect(reload?.executeOnSelect).toBe(true)
  })

  test('其它命令不带 executeOnSelect', () => {
    const items = getCommonSlashSuggestionItems()
    const mcp = items.find((i) => i.id === 'mcp')
    expect(mcp?.executeOnSelect).toBeFalsy()
  })
})
