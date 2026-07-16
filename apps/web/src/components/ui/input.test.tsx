import { describe, expect, test } from 'bun:test'
import { Input } from './input'

describe('Input', () => {
  test('forwards refs to the underlying input', () => {
    expect((Input as unknown as { $$typeof?: symbol }).$$typeof)
      .toBe(Symbol.for('react.forward_ref'))
  })
})
