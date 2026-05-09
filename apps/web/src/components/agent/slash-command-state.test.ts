import { describe, expect, test } from 'bun:test'
import { buildSlashSuggestionItems, normalizeSlashSuggestionItems } from './slash-command-state'

describe('buildSlashSuggestionItems', () => {
  test('returns common slash commands ahead of workspace skills', () => {
    const items = buildSlashSuggestionItems([
      { slug: 'using-superpowers', name: 'Using Superpowers', description: 'Bootstrap the workflow' },
      { slug: 'debug', name: 'Debug', description: 'Investigate runtime failures' },
    ], '')

    expect(items.slice(0, 3).map((item) => item.title)).toEqual(['/clear', '/compact', '/resume'])
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
