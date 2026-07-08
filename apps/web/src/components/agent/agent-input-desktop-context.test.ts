import { describe, expect, test } from 'bun:test'
import { DESKTOP_CONTEXT_IPC_CHANNELS } from '@lume/shared'
import {
  captureAgentInputDesktopContextState,
  captureAgentInputDesktopContextTarget,
  createDesktopContextMessageMetadata,
  resolveAgentInputDesktopContextView,
  resolveAgentInputDesktopMessageMetadata,
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

  test('prefers a desktop pre-captured app context before falling back to foreground capture', async () => {
    const sidecarCalls: unknown[] = []
    const state = await captureAgentInputDesktopContextState(
      async (...args) => {
        sidecarCalls.push(args)
        return { status: 'ok' }
      },
      async () => ({
        status: 'ok',
        snapshotId: 'snap-before-lume-focus',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
        capturedAt: 123,
      }),
    )

    expect(state).toEqual({
      status: 'ready',
      target: {
        snapshotId: 'snap-before-lume-focus',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
        capturedAt: 123,
      },
    })
    expect(sidecarCalls).toEqual([])
  })

  test('falls back to sidecar foreground capture when no pre-captured app exists', async () => {
    const state = await captureAgentInputDesktopContextState(
      async () => ({
        status: 'ok',
        snapshotId: 'snap-sidecar',
        app: { id: 'word.exe', name: 'Word' },
        window: { id: 'win:word', title: '周报.docx' },
      }),
      async () => ({ status: 'unavailable', message: 'no pre-captured context' }),
    )

    expect(state).toEqual({
      status: 'ready',
      target: {
        snapshotId: 'snap-sidecar',
        app: { id: 'word.exe', name: 'Word' },
        window: { id: 'win:word', title: '周报.docx' },
      },
    })
  })

  test('keeps the pre-captured app while Lume owns foreground focus', async () => {
    const sidecarCalls: unknown[] = []
    const state = await captureAgentInputDesktopContextState(
      async (...args) => {
        sidecarCalls.push(args)
        return { status: 'unavailable' }
      },
      async () => ({
        status: 'ok',
        snapshotId: 'snap-before-lume-focus',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
        capturedAt: 1_000,
      }),
    )

    expect(state).toEqual({
      status: 'ready',
      target: {
        snapshotId: 'snap-before-lume-focus',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
        capturedAt: 1_000,
      },
    })
    expect(sidecarCalls).toEqual([])
  })

  test('does not attach Lume itself as the current desktop app', async () => {
    expect(await captureAgentInputDesktopContextState(async () => ({
      status: 'ok',
      snapshotId: 'snap-lume',
      app: { id: 'electron.exe', name: 'electron.exe' },
      window: { id: 'win:lume', title: 'Lume' },
      capturedAt: 10_000,
    }))).toEqual({
      status: 'unavailable',
      message: '当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。',
    })

    expect(await captureAgentInputDesktopContextState(
      async () => ({ status: 'unavailable', message: 'sidecar should not be used' }),
      async () => ({
        status: 'ok',
        snapshotId: 'snap-lume-quick',
        app: { id: 'lume.exe', name: 'Lume' },
        window: { id: 'win:lume-quick', title: 'Lume Quick Input' },
        capturedAt: 10_000,
      }),
    )).toEqual({
      status: 'unavailable',
      message: '当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。',
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

  test('uses a parent desktop context target as persistent message metadata', () => {
    expect(resolveAgentInputDesktopMessageMetadata({
      propTarget: {
        snapshotId: 'snap-pinned',
        app: { id: 'word.exe', name: 'Word' },
        window: { id: 'win:word', title: '周报.docx' },
      },
      localTarget: undefined,
      messageMetadata: { source: 'manual' },
    })).toEqual({
      source: 'manual',
      desktopContextSnapshotId: 'snap-pinned',
      desktopApp: { id: 'word.exe', name: 'Word' },
      desktopWindow: { id: 'win:word', title: '周报.docx' },
    })
  })

  test('prefers the latest locally selected desktop context over the parent target', () => {
    expect(resolveAgentInputDesktopMessageMetadata({
      propTarget: {
        snapshotId: 'snap-old',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
      },
      localTarget: {
        snapshotId: 'snap-new',
        app: { id: 'word.exe', name: 'Word' },
        window: { id: 'win:word', title: '周报.docx' },
      },
    })).toEqual({
      desktopContextSnapshotId: 'snap-new',
      desktopApp: { id: 'word.exe', name: 'Word' },
      desktopWindow: { id: 'win:word', title: '周报.docx' },
    })
  })

  test('shows freshly captured current app in the plus panel without replacing the selected conversation context', () => {
    const selected = {
      snapshotId: 'snap-old',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:wechat', title: '项目群' },
    }
    const captured = {
      snapshotId: 'snap-current',
      app: { id: 'word.exe', name: 'Word' },
      window: { id: 'win:word', title: '周报.docx' },
    }

    expect(resolveAgentInputDesktopContextView({
      propTarget: selected,
      capturedTarget: captured,
      localTarget: undefined,
      captureLoading: false,
      captureMessage: undefined,
    })).toEqual({
      selectedTarget: selected,
      plusPanelTarget: captured,
      showPlusPanelSection: true,
    })
  })

  test('shows capture diagnostics in the plus panel instead of re-offering a stale selected app', () => {
    const selected = {
      snapshotId: 'snap-old',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:wechat', title: '项目群' },
    }

    expect(resolveAgentInputDesktopContextView({
      propTarget: selected,
      capturedTarget: undefined,
      localTarget: undefined,
      captureLoading: false,
      captureMessage: '当前前台窗口是 Lume',
    })).toEqual({
      selectedTarget: selected,
      plusPanelTarget: undefined,
      showPlusPanelSection: true,
    })
  })
})
