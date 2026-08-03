import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { SUGGESTION_IPC_CHANNELS } from '@lume/shared'

const invokeMock = mock(async (_command: string, _payload?: unknown) => ({}))
const unlistenMock = mock(() => {})

// listen captures the registered listener so tests can dispatch events.
let listenHandler: ((event: { payload: unknown }) => void) | null = null
const listenMock = mock(
  (
    _channel: string,
    listener: (event: { payload: unknown }) => void,
  ): Promise<() => void> => {
    listenHandler = listener
    return Promise.resolve(unlistenMock)
  },
)

mock.module('@/lib/desktop-runtime/core', () => ({
  invoke: invokeMock,
}))

mock.module('@/lib/desktop-runtime/event', () => ({
  listen: listenMock,
}))

const suggestionApi = await import('./suggestion')

describe('desktop suggestion API', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    listenMock.mockClear()
    unlistenMock.mockClear()
    listenHandler = null
    invokeMock.mockImplementation(async () => ({}))
  })

  test('listSuggestions routes through LIST channel, omits status when absent', async () => {
    await suggestionApi.listSuggestions()
    await suggestionApi.listSuggestions('accepted')

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.LIST, params: {} }],
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.LIST, params: { status: 'accepted' } }],
    ])
  })

  test('actOnSuggestion routes id + feedback through ACT channel', async () => {
    await suggestionApi.actOnSuggestion(7, 'never')

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.ACT, params: { id: 7, feedback: 'never' } }],
    ])
  })

  test('getSuggestionStats / clearAllSuggestions call with empty params', async () => {
    await suggestionApi.getSuggestionStats()
    await suggestionApi.clearAllSuggestions()

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.STATS, params: {} }],
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.CLEAR_ALL, params: {} }],
    ])
  })

  test('deleteSuggestion routes id through DELETE channel', async () => {
    await suggestionApi.deleteSuggestion(42)

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.DELETE, params: { id: 42 } }],
    ])
  })

  test('runSuggestionAnalysis omits workspaceSlug when absent', async () => {
    await suggestionApi.runSuggestionAnalysis()
    await suggestionApi.runSuggestionAnalysis('my-team')

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS, params: {} }],
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS, params: { workspaceSlug: 'my-team' } }],
    ])
  })

  test('setSuggestionsEnabled routes boolean through SET_ENABLED channel', async () => {
    await suggestionApi.setSuggestionsEnabled(false)

    expect(invokeMock.mock.calls).toEqual([
      ['sidecar_call', { method: SUGGESTION_IPC_CHANNELS.SET_ENABLED, params: { enabled: false } }],
    ])
  })

  test('onSuggestionsChanged subscribes to sidecar:event, filters CHANGED, returns unsubscribe', async () => {
    const cb = mock((_signal: { type: 'suggestions_changed' }) => {})
    const unsub = suggestionApi.onSuggestionsChanged(cb)

    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(listenMock.mock.calls[0][0]).toBe('sidecar:event')
    expect(listenHandler).toBeTypeOf('function')

    // 无关 method 不触发回调
    listenHandler!({ payload: { method: 'something:else', params: {} } })
    expect(cb).not.toHaveBeenCalled()

    // CHANGED → 回调收到 signal payload
    const signal = { type: 'suggestions_changed' as const }
    listenHandler!({ payload: { method: SUGGESTION_IPC_CHANNELS.CHANGED, params: signal } })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toEqual(signal)

    // unsubscribe 调用底层 unlisten
    await unsub.then((fn) => fn())
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })
})
