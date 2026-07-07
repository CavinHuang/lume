import { describe, expect, test } from 'bun:test'
import { DESKTOP_CONTEXT_IPC_CHANNELS } from '@lume/shared'
import {
  captureAgentInputDesktopContextState,
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

    expect(calls).toEqual([{
      method: DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT,
      params: { userInitiated: true },
    }])
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

  test('returns a diagnosable capture state when the current app cannot be attached', async () => {
    expect(await captureAgentInputDesktopContextState(async () => ({
      status: 'unavailable',
      message: 'desktop assistant is disabled',
    }))).toEqual({
      status: 'unavailable',
      message: 'desktop assistant is disabled',
    })

    expect(await captureAgentInputDesktopContextState(async () => ({
      status: 'ok',
      snapshotId: 'snap-missing-window',
      app: { id: 'wechat.exe', name: '微信' },
    }))).toEqual({
      status: 'unavailable',
      message: '未能读取当前应用窗口',
    })

    expect(await captureAgentInputDesktopContextState(async () => {
      throw new Error('sidecar disconnected')
    })).toEqual({
      status: 'unavailable',
      message: 'sidecar disconnected',
    })
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
