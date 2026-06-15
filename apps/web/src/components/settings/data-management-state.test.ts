import { describe, expect, test } from 'bun:test'
import {
  CLEANUP_OPTIONS,
  createDefaultCleanupSelection,
  hasSelectedCleanup,
  type CleanupSelection,
  formatBytes,
} from './data-management-state'

describe('data-management-state', () => {
  test('CLEANUP_OPTIONS 含 5 项且均为可重建', () => {
    const keys = CLEANUP_OPTIONS.map((o) => o.key)
    expect(keys).toEqual(['frontendTemp', 'previewRender', 'logs', 'vectorIndex', 'pluginsCache'])
    expect(CLEANUP_OPTIONS.every((o) => o.rebuildable)).toBe(true)
  })

  test('默认全选可重建项', () => {
    const sel = createDefaultCleanupSelection()
    expect(sel.frontendTemp).toBe(true)
    expect(sel.vectorIndex).toBe(true)
    expect(sel.pluginsCache).toBe(true)
  })

  test('hasSelectedCleanup 反映选择', () => {
    expect(hasSelectedCleanup(createDefaultCleanupSelection())).toBe(true)
    const empty: CleanupSelection = {
      frontendTemp: false,
      previewRender: false,
      logs: false,
      vectorIndex: false,
      pluginsCache: false,
    }
    expect(hasSelectedCleanup(empty)).toBe(false)
  })

  test('formatBytes 人类可读', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB')
  })
})
