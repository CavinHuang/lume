import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  READING_IPC_CHANNELS,
  WEREAD_KEY_PAGE_URL,
  WEREAD_IPC_CHANNELS,
} from '@lume/shared'

const invokeMock = mock(async (_command: string, _payload?: unknown) => ({}))
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

mock.module('@/lib/desktop-runtime/core', () => ({
  invoke: invokeMock,
}))

mock.module('@lume/ui', () => ({
  clearHighlightCache: () => false,
}))

const readingApi = await import('./reading')

describe('desktop reading API', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    invokeMock.mockImplementation(async () => ({}))
    readingApi.clearWereadApiCache()
  })

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'navigator')
    }
  })

  function mockClipboardText(text: string) {
    const readText = mock(async () => text)
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          readText,
        },
      },
    })
    return readText
  }

  test('routes active WeRead methods through the desktop sidecar command', async () => {
    await readingApi.getWereadApiKey()
    await readingApi.getWereadShelf()
    await readingApi.getWereadReviews('wr-1')

    expect(invokeMock.mock.calls).toEqual([
      [
        'sidecar_call',
        {
          method: WEREAD_IPC_CHANNELS.GET_KEY,
          params: {},
        },
      ],
      [
        'sidecar_call',
        {
          method: WEREAD_IPC_CHANNELS.GET_SHELF,
          params: {},
        },
      ],
      [
        'sidecar_call',
        {
          method: WEREAD_IPC_CHANNELS.GET_REVIEWS,
          params: {
            bookId: 'wr-1',
          },
        },
      ],
    ])
  })

  test('caches WeRead read-only data and clears it after reconnecting', async () => {
    invokeMock.mockImplementation(async (_command, payload) => {
      const params = payload as { method?: string } | undefined
      if (params?.method === WEREAD_IPC_CHANNELS.GET_SHELF) return { books: [{ title: '缓存书架' }] }
      if (params?.method === READING_IPC_CHANNELS.CONNECT_WEREAD) return { connected: true }
      return {}
    })

    await expect(readingApi.getWereadShelf()).resolves.toEqual({ books: [{ title: '缓存书架' }] })
    await expect(readingApi.getWereadShelf()).resolves.toEqual({ books: [{ title: '缓存书架' }] })
    await readingApi.connectReadingWeread({ apiKey: 'wrk-lume-test-key' })
    await readingApi.getWereadShelf()

    expect(invokeMock.mock.calls.map((call) => (call[1] as { method?: string } | undefined)?.method)).toEqual([
      WEREAD_IPC_CHANNELS.GET_SHELF,
      READING_IPC_CHANNELS.CONNECT_WEREAD,
      WEREAD_IPC_CHANNELS.GET_SHELF,
    ])
  })

  test('opens the desktop WeRead key page and reads a copied API key', async () => {
    invokeMock.mockImplementation(async (command) => (
      command === 'read_clipboard_text' ? ' wrk-lume-test-key ' : {}
    ))

    const result = await readingApi.openAndFetchWereadKey()

    expect(result).toEqual({
      ok: true,
      key: 'wrk-lume-test-key',
      url: WEREAD_KEY_PAGE_URL,
    })
    expect(invokeMock.mock.calls).toEqual([
      [
        'open_weread_key_webview',
        {
          url: WEREAD_KEY_PAGE_URL,
        },
      ],
      [
        'read_clipboard_text',
      ],
    ])
  })

  test('rejects clipboard text that is not a WeRead API key', async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === 'read_clipboard_text') throw new Error('desktop clipboard unavailable')
      return {}
    })
    const readText = mockClipboardText('not-a-weread-key')

    const result = await readingApi.readWereadKeyFromClipboard()

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_clipboard',
      url: WEREAD_KEY_PAGE_URL,
    })
    expect(readText).toHaveBeenCalled()
    expect(invokeMock.mock.calls).toEqual([
      [
        'read_clipboard_text',
      ],
    ])
  })
})
