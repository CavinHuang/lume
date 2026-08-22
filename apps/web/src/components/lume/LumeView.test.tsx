import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('Lume feature navigation', () => {
  test('keeps reading and routine as peer feature entries', () => {
    const source = readFileSync(new URL('./LumeView.tsx', import.meta.url), 'utf8')
    expect(source).toContain("{ id: 'reading', label: '一起读书'")
    expect(source).toContain("{ id: 'routine', label: '今日日程'")
    expect(source).toContain("localStorage?.setItem(STORAGE_KEY, next)")
  })
})
