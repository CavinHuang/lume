import { describe, expect, test } from 'bun:test'
import { MODEL_META_IPC_CHANNELS } from '@lume/shared'

describe('MODEL_META_IPC_CHANNELS', () => {
  test('GET channel 常量为 model-meta:get', () => {
    expect(MODEL_META_IPC_CHANNELS.GET).toBe('model-meta:get')
  })

  test('从 @lume/shared 根导出可访问', () => {
    expect(typeof MODEL_META_IPC_CHANNELS.GET).toBe('string')
  })
})
