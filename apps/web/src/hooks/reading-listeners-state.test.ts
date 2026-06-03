import { describe, expect, test } from 'bun:test'
import { READING_IPC_CHANNELS } from '@lume/shared'
import { buildReadingGenerationToast } from './reading-listeners-state'

describe('reading listeners state', () => {
  test('builds a success toast for Alice-like Reading note completion events', () => {
    expect(buildReadingGenerationToast(READING_IPC_CHANNELS.NOTE_GEN_DONE, {
      status: 'completed',
      bookTitle: '我在北京送快递',
      message: '已写下读书种子札记',
    })).toEqual({
      kind: 'success',
      message: '《我在北京送快递》已写好读书笔记',
    })
  })

  test('builds a failure toast for Alice-like Reading note failed events', () => {
    expect(buildReadingGenerationToast(READING_IPC_CHANNELS.NOTE_GEN_FAILED, {
      status: 'skipped',
      message: '暂无可读书籍',
    })).toEqual({
      kind: 'error',
      message: '读书笔记暂时没有生成：暂无可读书籍',
    })
  })

  test('ignores unrelated sidecar events', () => {
    expect(buildReadingGenerationToast('agent:title-updated', {})).toBeNull()
  })
})
