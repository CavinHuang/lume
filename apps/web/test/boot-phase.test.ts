import { describe, expect, test } from 'bun:test'
import {
  BOOT_HINT,
  BOOT_TIMINGS,
  PHASE_COPY,
  resolveBootPhase,
  shouldShowHint,
} from '../src/components/boot/boot-phase'

describe('resolveBootPhase', () => {
  test('awaken within the awaken window', () => {
    expect(resolveBootPhase(false, 0)).toBe('awaken')
    expect(resolveBootPhase(false, BOOT_TIMINGS.awakenMs - 1)).toBe('awaken')
  })

  test('organize after the awaken window', () => {
    expect(resolveBootPhase(false, BOOT_TIMINGS.awakenMs)).toBe('organize')
    const organizeEnd = BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs
    expect(resolveBootPhase(false, organizeEnd - 1)).toBe('organize')
  })

  test('memory rests after the organize window until ready', () => {
    const organizeEnd = BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs
    expect(resolveBootPhase(false, organizeEnd)).toBe('memory')
    expect(resolveBootPhase(false, organizeEnd + 999_999)).toBe('memory')
  })

  test('ready overrides elapsed time', () => {
    expect(resolveBootPhase(true, 0)).toBe('ready')
    expect(resolveBootPhase(true, 9_999)).toBe('ready')
  })
})

describe('shouldShowHint', () => {
  test('hidden while ready', () => {
    expect(shouldShowHint(true, 9_999)).toBe(false)
  })

  test('hidden before the threshold while waiting', () => {
    expect(shouldShowHint(false, 0)).toBe(false)
    expect(shouldShowHint(false, BOOT_TIMINGS.hintThresholdMs - 1)).toBe(false)
  })

  test('shown at/after the threshold while waiting', () => {
    expect(shouldShowHint(false, BOOT_TIMINGS.hintThresholdMs)).toBe(true)
    expect(shouldShowHint(false, 9_999)).toBe(true)
  })
})

describe('copy assets', () => {
  test('every phase has non-empty copy', () => {
    const phases = ['awaken', 'organize', 'memory', 'ready'] as const
    for (const phase of phases) {
      const copy = PHASE_COPY[phase]
      expect(copy.status.length).toBeGreaterThan(0)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.subtitle.length).toBeGreaterThan(0)
    }
  })

  test('slow-boot hint is non-empty', () => {
    expect(BOOT_HINT.length).toBeGreaterThan(0)
  })
})
