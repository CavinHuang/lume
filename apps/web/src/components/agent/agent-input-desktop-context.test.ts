import { describe, expect, test } from 'bun:test'
import { DESKTOP_CONTEXT_IPC_CHANNELS } from '@lume/shared'
import {
  captureAgentInputDesktopContextTarget,
  createDesktopContextMessageMetadata,
} from './agent-input-desktop-context'

describe('agent-input desktop context helpers', () => {
  test('captures the current desktop app as a selectable conversation target', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const target = await captureAgentInputDesktopContextTarget(async (method, params) => {
      calls.push({ method, params })
      return {
        status: 'ok',
        snapshotId: 'snap-current',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:1', title: '项目群' },
        capturedAt: 123,
      }
    })

    expect(calls).toEqual([{ method: DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT, params: {} }])
    expect(target).toEqual({
      snapshotId: 'snap-current',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:1', title: '项目群' },
      capturedAt: 123,
    })
  })

  test('ignores invalid or unavailable capture results', async () => {
    expect(await captureAgentInputDesktopContextTarget(async () => ({
      status: 'unavailable',
      message: 'desktop assistant is disabled',
    }))).toBeUndefined()
    expect(await captureAgentInputDesktopContextTarget(async () => ({
      status: 'ok',
      snapshotId: 'snap-missing-window',
      app: { id: 'wechat.exe', name: '微信' },
    }))).toBeUndefined()
  })

  test('creates non-sensitive message metadata from the selected app context', () => {
    expect(createDesktopContextMessageMetadata({
      snapshotId: 'snap-current',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:1', title: '项目群' },
      capturedAt: 123,
    })).toEqual({
      desktopContextSnapshotId: 'snap-current',
      desktopApp: { id: 'wechat.exe', name: '微信' },
      desktopWindow: { id: 'win:1', title: '项目群' },
    })
  })
})
