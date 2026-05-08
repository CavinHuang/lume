import { describe, expect, test } from 'bun:test'
import { showTemporaryCopiedFeedback, type CopyFeedbackState } from './RunEventContentBlock'

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
