import { describe, expect, test } from 'bun:test'
import {
  cancelPendingDebouncedAgentInputSend,
  createDebouncedAgentInputSend,
} from './agent-input-send-debounce'

describe('createDebouncedAgentInputSend', () => {
  test('runs immediately and drops repeated sends in the debounce window', () => {
    let calls = 0
    const send = createDebouncedAgentInputSend(() => {
      calls += 1
    })

    send()
    send()
    send()
    send.cancel()

    expect(calls).toBe(1)
  })

  test('cleanup does not permanently disable future sends', () => {
    let calls = 0
    const send = createDebouncedAgentInputSend(() => {
      calls += 1
    })

    cancelPendingDebouncedAgentInputSend(send)
    send()
    cancelPendingDebouncedAgentInputSend(send)

    expect(calls).toBe(1)
  })
})
