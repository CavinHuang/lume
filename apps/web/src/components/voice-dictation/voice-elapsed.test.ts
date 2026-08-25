import { describe, expect, test } from 'bun:test'
import { formatVoiceElapsed } from './use-voice-dictation'

describe('formatVoiceElapsed', () => {
  test('pads minutes and seconds to mm:ss', () => {
    expect(formatVoiceElapsed(0)).toBe('00:00')
    expect(formatVoiceElapsed(5)).toBe('00:05')
    expect(formatVoiceElapsed(65)).toBe('01:05')
    expect(formatVoiceElapsed(3600)).toBe('60:00')
  })
})
