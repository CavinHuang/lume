import { describe, expect, test } from 'bun:test'
import { DIALOG_CONTENT_CLASSNAME, DIALOG_OVERLAY_CLASSNAME } from './dialog'

describe('Dialog layering', () => {
  test('overlay sits above the app shell stacking context', () => {
    expect(DIALOG_OVERLAY_CLASSNAME).toContain('z-[120]')
  })

  test('content sits above the overlay', () => {
    expect(DIALOG_CONTENT_CLASSNAME).toContain('z-[121]')
  })
})
