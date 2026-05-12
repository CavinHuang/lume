import { describe, expect, test } from 'bun:test'
import { showTemporaryCopiedFeedback, type CopyFeedbackState } from './RuntimeEventContentBlock'
import { normalizeThreadFilePathCandidate } from './thread-file-links'

describe('showTemporaryCopiedFeedback', () => {
  test('sets copied immediately, clears the previous timer, and resets after 3 seconds', () => {
    const copiedStates: boolean[] = []
    const clearedTimerIds: number[] = []
    const scheduled: Array<{ id: number; delayMs: number; callback: () => void }> = []
    let nextTimerId = 1
    const state: CopyFeedbackState = { resetTimeoutId: null }

    const setTimer = (callback: () => void, delayMs: number) => {
      const id = nextTimerId
      nextTimerId += 1
      scheduled.push({ id, delayMs, callback })
      return id as ReturnType<typeof setTimeout>
    }

    const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
      clearedTimerIds.push(handle as number)
    }

    showTemporaryCopiedFeedback(state, {
      setCopied: (next) => copiedStates.push(next),
      setTimer,
      clearTimer,
    })

    expect(copiedStates).toEqual([true])
    expect(state.resetTimeoutId).toBe(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delayMs).toBe(3000)

    showTemporaryCopiedFeedback(state, {
      setCopied: (next) => copiedStates.push(next),
      setTimer,
      clearTimer,
    })

    expect(clearedTimerIds).toEqual([1])
    expect(copiedStates).toEqual([true, true])
    expect(state.resetTimeoutId).toBe(2)
    expect(scheduled).toHaveLength(2)

    scheduled[1]?.callback()

    expect(copiedStates).toEqual([true, true, false])
    expect(state.resetTimeoutId).toBeNull()
  })
})

describe('normalizeThreadFilePathCandidate', () => {
  test('accepts relative thread file paths and rejects external or unsafe paths', () => {
    expect(normalizeThreadFilePathCandidate('plans/deepseek-open-source-research.md')).toBe('plans/deepseek-open-source-research.md')
    expect(normalizeThreadFilePathCandidate('files/My Report.md')).toBe('files/My Report.md')
    expect(normalizeThreadFilePathCandidate('files\\notes\\brief.md')).toBe('files/notes/brief.md')
    expect(normalizeThreadFilePathCandidate('https://example.com/report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('/Users/me/report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('../report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('report.md')).toBeNull()
  })
})
