import { describe, expect, test } from 'bun:test'
import { deriveLumeComposerState } from './lume-composer-state'

describe('deriveLumeComposerState', () => {
  test('empty text and enabled composer stays idle without send or stop affordances', () => {
    expect(
      deriveLumeComposerState({
        text: '   ',
        disabled: false,
      }),
    ).toEqual({
      canSend: false,
      showStop: false,
      tone: 'idle',
    })
  })

  test('disabled composer shows streaming tone with stop affordance', () => {
    expect(
      deriveLumeComposerState({
        text: 'ship it',
        disabled: true,
      }),
    ).toEqual({
      canSend: false,
      showStop: true,
      tone: 'streaming',
    })
  })

  test('non-empty text and enabled composer is ready to send', () => {
    expect(
      deriveLumeComposerState({
        text: 'ship it',
        disabled: false,
      }),
    ).toEqual({
      canSend: true,
      showStop: false,
      tone: 'ready',
    })
  })
})
