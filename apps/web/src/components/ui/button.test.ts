import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Button } from './button'

describe('Button', () => {
  test('is a forwardRef component so overlay primitives can attach refs', () => {
    expect((Button as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.forward_ref'))
  })

  test('preserves its display name for debugging', () => {
    expect((Button as React.NamedExoticComponent).displayName).toBe('Button')
  })
})
