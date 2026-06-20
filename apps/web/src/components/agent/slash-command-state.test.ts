import { describe, expect, test } from 'bun:test'
import { buildSlashSuggestionItems, getCommonSlashSuggestionItems, normalizeSlashSuggestionItems } from './slash-command-state'

describe('buildSlashSuggestionItems', () => {
  test('returns common slash commands ahead of workspace skills', () => {
    const items = buildSlashSuggestionItems([
      { slug: 'using-superpowers', name: 'Using Superpowers', description: 'Bootstrap the workflow' },
      { slug: 'debug', name: 'Debug', description: 'Investigate runtime failures' },
    ], '')

    expect(items.slice(0, 2).map((item) => item.title)).toEqual(['/clear', '/compact'])
    expect(items.some((item) => item.title === '/using-superpowers' && item.section === 'skill')).toBe(true)
  })

  test('filters both quick actions and skills with the same query', () => {
    const items = buildSlashSuggestionItems([
      { slug: 'debug', name: 'Debug', description: 'Investigate runtime failures' },
      { slug: 'review', name: 'Review', description: 'Review recent changes' },
    ], 'deb')

    expect(items).toEqual([
      expect.objectContaining({ title: '/debug', section: 'skill' }),
    ])
  })

  test('matches localized command keywords', () => {
    const items = buildSlashSuggestionItems([], '压缩')

    expect(items).toEqual([
      expect.objectContaining({ title: '/compact', section: 'capability' }),
    ])
  })

  test('normalizes legacy skill-only mention items for slash rendering', () => {
    const items = normalizeSlashSuggestionItems([
      { id: 'pdf', label: 'pdf', type: 'skill' },
    ])

    expect(items[0]).toEqual(expect.objectContaining({ title: '/clear', section: 'capability' }))
    expect(items).toContainEqual(expect.objectContaining({
      id: 'pdf',
      title: '/pdf',
      section: 'skill',
      subtitle: '工作区技能',
    }))
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
