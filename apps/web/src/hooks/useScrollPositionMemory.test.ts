import { describe, expect, test } from 'bun:test'

function restoreScrollPosition(
  positions: Record<string, number>,
  id: string,
  el: { scrollTop: number } | null,
) {
  if (el && positions[id] !== undefined) {
    el.scrollTop = positions[id]
    return true
  }
  return false
}

describe('useScrollPositionMemory restore semantics', () => {
  test('returns false when no saved position exists for the thread', () => {
    const element = { scrollTop: 0 }

    const restored = restoreScrollPosition({}, 'thread-1', element)

    expect(restored).toBe(false)
    expect(element.scrollTop).toBe(0)
  })

  test('returns true and restores the saved scroll position', () => {
    const element = { scrollTop: 0 }

    const restored = restoreScrollPosition({ 'thread-1': 240 }, 'thread-1', element)

    expect(restored).toBe(true)
    expect(element.scrollTop).toBe(240)
  })
})
