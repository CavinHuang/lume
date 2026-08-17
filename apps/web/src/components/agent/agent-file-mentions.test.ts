import { describe, expect, test } from 'bun:test'
import { buildFileMentionItems } from './agent-file-mentions'

describe('buildFileMentionItems', () => {
  const entries = [
    { name: 'README.md', path: 'README.md', type: 'file' as const },
    { name: 'agent.ts', path: 'src/agent.ts', type: 'file' as const },
    { name: 'agent.test.ts', path: 'src/agent.test.ts', type: 'file' as const },
    { name: 'assets', path: 'assets', type: 'dir' as const },
  ]

  test('excludes directories and tags source in id/section/meta', () => {
    const items = buildFileMentionItems(entries, 'project', '')
    expect(items.map((item) => item.id)).toEqual([
      'project:README.md', 'project:src/agent.ts', 'project:src/agent.test.ts',
    ])
    expect(items[0]).toMatchObject({ label: 'project/README.md', section: 'project-file', meta: '项目' })
  })

  test('filters by name and path, prefix matches first', () => {
    const items = buildFileMentionItems(entries, 'session', 'agent')
    expect(items.map((item) => item.title)).toEqual(['agent.ts', 'agent.test.ts'])
    expect(items[0].section).toBe('session-file')
  })

  test('caps results at 12', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `file-${index}.ts`, path: `file-${index}.ts`, type: 'file' as const }))
    expect(buildFileMentionItems(many, 'project', '')).toHaveLength(12)
  })
})
