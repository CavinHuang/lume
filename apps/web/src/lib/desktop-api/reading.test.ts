import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  ALICE_READING_IPC_CHANNELS,
  READING_IPC_CHANNELS,
  WEREAD_KEY_PAGE_URL,
  WEREAD_IPC_CHANNELS,
} from '@lume/shared'

const invokeMock = mock(async (_command: string, _payload?: unknown) => ({}))
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

mock.module('@lume/ui', () => ({
  clearHighlightCache: () => false,
}))

const readingApi = await import('./reading')

describe('desktop reading API', () => {
  beforeEach(() => {
    invokeMock.mockClear()
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

  test('routes Lume and Alice Reading aliases through the desktop sidecar command', async () => {
    await readingApi.addBookToAlice('置身事内', '用户希望 Lume 一起读。')
    await readingApi.readingGetBooks()
    await readingApi.readingMarkNotesRead(['note-1'])

    expect(invokeMock.mock.calls).toEqual([
      [
        'sidecar_call',
        {
          method: READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE,
          params: {
            title: '置身事内',
            reason: '用户希望 Lume 一起读。',
          },
        },
      ],
      [
        'sidecar_call',
        {
          method: ALICE_READING_IPC_CHANNELS.GET_BOOKS,
          params: {},
        },
      ],
      [
        'sidecar_call',
        {
          method: ALICE_READING_IPC_CHANNELS.MARK_NOTES_READ,
          params: ['note-1'],
        },
      ],
    ])
  })

  test('routes Alice-like WeRead methods through the same desktop sidecar command', async () => {
    await readingApi.getWereadShelf()
    await readingApi.generateWereadNote({
      bookTitle: '我在北京送快递',
      text: '把自己看作一个普通人，过普通人的生活。',
      source: 'weread',
    })
    await readingApi.searchWereadBooks('胡安焉', 5)

    expect(invokeMock.mock.calls).toEqual([
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
          method: WEREAD_IPC_CHANNELS.GENERATE_NOTE,
          params: {
            bookTitle: '我在北京送快递',
            text: '把自己看作一个普通人，过普通人的生活。',
            source: 'weread',
          },
        },
      ],
      [
        'sidecar_call',
        {
          method: WEREAD_IPC_CHANNELS.SEARCH_BOOKS,
          params: {
            keyword: '胡安焉',
            limit: 5,
          },
        },
      ],
    ])
  })

  test('opens the desktop WeRead key page and reads a copied API key', async () => {
    const readText = mockClipboardText(' wr_lume_test_key ')

    const result = await readingApi.openAndFetchWereadKey()

    expect(result).toEqual({
      ok: true,
      key: 'wr_lume_test_key',
      url: WEREAD_KEY_PAGE_URL,
    })
    expect(readText).toHaveBeenCalled()
    expect(invokeMock.mock.calls).toEqual([
      [
        'open_external',
        {
          url: WEREAD_KEY_PAGE_URL,
        },
      ],
    ])
  })

  test('rejects clipboard text that is not a WeRead API key', async () => {
    const readText = mockClipboardText('not-a-weread-key')

    const result = await readingApi.readWereadKeyFromClipboard()

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_clipboard',
      url: WEREAD_KEY_PAGE_URL,
    })
    expect(readText).toHaveBeenCalled()
    expect(invokeMock.mock.calls).toEqual([])
  })
})
