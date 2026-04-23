import { describe, expect, test } from 'bun:test'
import { deriveLumeComposerState } from './lume-composer-state'

describe('deriveLumeComposerState', () => {
  test('empty text and enabled composer stays idle without send or stop affordances', () => {
    expect(
      deriveLumeComposerState({
        hasText: false,
        mode: 'idle',
      }),
    ).toEqual({
      canSend: false,
      showBusy: false,
      showStop: false,
      tone: 'idle',
    })
  })

  test('busy composer uses streaming tone without exposing stop affordance', () => {
    expect(
      deriveLumeComposerState({
        hasText: true,
        mode: 'busy',
      }),
    ).toEqual({
      canSend: false,
      showBusy: true,
      showStop: false,
      tone: 'streaming',
    })
  })

  test('stoppable streaming composer shows stop affordance with streaming tone', () => {
    expect(
      deriveLumeComposerState({
        hasText: true,
        mode: 'streaming',
      }),
    ).toEqual({
      canSend: false,
      showBusy: false,
      showStop: true,
      tone: 'streaming',
    })
  })

  test('non-empty text and enabled composer is ready to send', () => {
    expect(
      deriveLumeComposerState({
        hasText: true,
        mode: 'idle',
      }),
    ).toEqual({
      canSend: true,
      showBusy: false,
      showStop: false,
      tone: 'ready',
    })
  })
})
