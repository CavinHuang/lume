import { describe, expect, test } from 'bun:test'
import { keyboardEventToAccelerator } from './VoiceDictationSettings'

function keyEvent(init: Partial<KeyboardEventInit> & { key: string }): React.KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as unknown as React.KeyboardEvent
}

describe('keyboardEventToAccelerator', () => {
  test('alt+letter maps to Alt+<key>', () => {
    expect(keyboardEventToAccelerator(keyEvent({ key: 'v', altKey: true }))).toBe('Alt+V')
  })

  test('ctrl+shift+digit maps with both modifiers', () => {
    expect(
      keyboardEventToAccelerator(keyEvent({ key: '1', ctrlKey: true, shiftKey: true })),
    ).toBe('CommandOrControl+Shift+1')
  })

  test('function and navigation keys pass through', () => {
    expect(keyboardEventToAccelerator(keyEvent({ key: 'F5', ctrlKey: true }))).toBe('CommandOrControl+F5')
    expect(keyboardEventToAccelerator(keyEvent({ key: 'ArrowUp', altKey: true }))).toBe('Alt+ArrowUp')
    expect(keyboardEventToAccelerator(keyEvent({ key: ' ', ctrlKey: true }))).toBe('CommandOrControl+Space')
  })

  test('rejects plain letters and shift-only combos that would hijack typing', () => {
    expect(keyboardEventToAccelerator(keyEvent({ key: 'a' }))).toBeNull()
    expect(keyboardEventToAccelerator(keyEvent({ key: 'A', shiftKey: true }))).toBeNull()
  })

  test('rejects bare modifier presses', () => {
    expect(keyboardEventToAccelerator(keyEvent({ key: 'Alt', altKey: true }))).toBeNull()
    expect(keyboardEventToAccelerator(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull()
  })
})
