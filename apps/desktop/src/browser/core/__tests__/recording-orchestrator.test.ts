// 录制编排移植测试(recordBrowserVideo / executeRecordingActions / 光标 overlay 脚本)。
// 覆盖:阶段回调顺序、产物字段与 frameCount 估算、recordingId 清洗、
// 空产物失败路径(recorder.cancel + rm 清理)、场景中止、预中止短路、
// 指针/滚轮插值步数、光标安装/移除脚本关键片段。
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'
import {
  executeRecordingActions,
  installRecordingCursorOverlay,
  recordBrowserVideo,
  removeRecordingCursorOverlay,
  type RecordingScenarioAction,
} from '../recording/orchestrator'
import type { ControlledView, RecordingRecorder, RecordingRecorderOptions } from '../types'

interface FakeRecorderCalls {
  options?: RecordingRecorderOptions
  stopped: number
  cancelled: number
}

function makeFakeRecorder(calls: FakeRecorderCalls, onStop?: (path: string) => Promise<void>) {
  return async (options: RecordingRecorderOptions): Promise<RecordingRecorder> => {
    calls.options = options
    return {
      stop: async () => {
        calls.stopped += 1
        await onStop?.(options.outputPath)
      },
      cancel: async () => {
        calls.cancelled += 1
      },
    }
  }
}

describe('recordBrowserVideo', () => {
  test('成功路径:阶段顺序、产物字段、recordingId 清洗、frameCount 估算', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'lume-recording-test-'))
    try {
      const calls: FakeRecorderCalls = { stopped: 0, cancelled: 0 }
      const phases: string[] = []
      let captureComplete = 0
      const artifact = await recordBrowserVideo({
        tempRoot,
        recordingId: 'iab-recording:abc/1',
        targetFrame: {} as WebFrameMain,
        viewport: { width: 1280, height: 720 },
        fps: 25,
        signal: new AbortController().signal,
        now: (() => {
          let tick = 0
          return () => {
            tick += 500
            return tick
          }
        })(),
        onPhase: phase => phases.push(phase),
        onCaptureComplete: () => {
          captureComplete += 1
        },
        executeScenario: async () => {},
        createRecorder: makeFakeRecorder(calls, async path => {
          await writeFile(path, 'webm-bytes')
        }),
      })
      expect(calls.options?.outputPath).toBe(join(tempRoot, 'iab-recording-abc-1.webm'))
      expect(phases).toEqual(['capturing', 'finalizing'])
      expect(captureComplete).toBe(1)
      expect(calls.stopped).toBe(1)
      expect(calls.cancelled).toBe(0)
      expect(artifact).toEqual({
        path: join(tempRoot, 'iab-recording-abc-1.webm'),
        mimeType: 'video/webm',
        width: 1280,
        height: 720,
        fps: 25,
        durationMs: 500,
        frameCount: Math.max(1, Math.round((500 / 1000) * 25)),
      })
      expect((await stat(artifact.path)).size).toBeGreaterThan(0)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('空产物:抛错并 cancel 录制器', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'lume-recording-test-'))
    try {
      const calls: FakeRecorderCalls = { stopped: 0, cancelled: 0 }
      const artifactPath = join(tempRoot, 'iab-recording-x.webm')
      // 预置 0 字节产物, 命中 size===0 校验分支
      await writeFile(artifactPath, '')
      await expect(
        recordBrowserVideo({
          tempRoot,
          recordingId: 'iab-recording-x',
          targetFrame: {} as WebFrameMain,
          viewport: { width: 1280, height: 720 },
          fps: 25,
          signal: new AbortController().signal,
          executeScenario: async () => {},
          createRecorder: makeFakeRecorder(calls),
        }),
      ).rejects.toThrow('Browser recording produced an empty WebM artifact')
      expect(calls.cancelled).toBe(1)
      expect(calls.options?.outputPath).toBe(artifactPath)
      await expect(stat(artifactPath)).rejects.toThrow()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('场景抛错/中止:cancel + 清理,AbortError 透传', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'lume-recording-test-'))
    try {
      const calls: FakeRecorderCalls = { stopped: 0, cancelled: 0 }
      const artifactPath = join(tempRoot, 'rec-fail.webm')
      // 预置产物文件, 证明失败路径会删除临时文件
      await writeFile(artifactPath, 'stale')
      const scenarioError = new Error('scenario boom')
      await expect(
        recordBrowserVideo({
          tempRoot,
          recordingId: 'rec-fail',
          targetFrame: {} as WebFrameMain,
          viewport: { width: 640, height: 480 },
          fps: 25,
          signal: new AbortController().signal,
          executeScenario: async () => {
            throw scenarioError
          },
          createRecorder: makeFakeRecorder(calls),
        }),
      ).rejects.toThrow('scenario boom')
      expect(calls.stopped).toBe(0)
      expect(calls.cancelled).toBe(1)
      await expect(stat(artifactPath)).rejects.toThrow()

      const controller = new AbortController()
      controller.abort()
      await expect(
        recordBrowserVideo({
          tempRoot,
          recordingId: 'rec-aborted',
          targetFrame: {} as WebFrameMain,
          viewport: { width: 640, height: 480 },
          fps: 25,
          signal: controller.signal,
          executeScenario: async () => {},
          createRecorder: makeFakeRecorder({ stopped: 0, cancelled: 0 }),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('executeRecordingActions', () => {
  function makeView(cdpCalls: Array<{ method: string; params?: Record<string, unknown> }>): ControlledView {
    return {
      webContents: {
        loadURL: async () => {},
        getURL: () => '',
        getTitle: () => '',
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => {},
        goForward: () => {},
        reload: () => {},
        executeJavaScript: async () => ({}),
      },
      cdp: {
        send: async (method: string, params?: Record<string, unknown>) => {
          cdpCalls.push({ method, params })
        },
      },
      normalizeScreenshotToCssPixels: false,
    }
  }

  test('move 按 ≤60 步插值,wheel 按 times 派发 scroll,非法 click 报错', async () => {
    const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const view = makeView(cdpCalls)
    const commands: Array<{ method: string; x?: number; y?: number }> = []
    const actions: RecordingScenarioAction[] = [
      { type: 'move', x: 100, y: 200, durationMs: 32 },
      { type: 'wheel', deltaX: 0, deltaY: 120, times: 2 },
    ]
    await executeRecordingActions({
      view,
      actions,
      signal: new AbortController().signal,
      viewport: { width: 800, height: 600 },
      executeCommand: async (_view, command) => {
        commands.push(command)
        return { ok: true }
      },
      executeLocator: async () => ({ kind: 'done', value: undefined }),
    })
    // steps = max(1, min(60, round(32/16))) = 2, 起点为视口中心 (400,300)
    const moves = cdpCalls.filter(call => call.params?.type === 'mouseMoved')
    expect(moves.length).toBe(2)
    expect(moves[0]?.params).toMatchObject({ x: 400 + (100 - 400) / 2, y: 300 + (200 - 300) / 2 })
    expect(moves[1]?.params).toMatchObject({ x: 100, y: 200 })
    expect(commands.length).toBe(2)
    expect(commands[0]).toMatchObject({ method: 'scroll', x: 0, y: 120 })
    await expect(
      executeRecordingActions({
        view,
        actions: [{ type: 'click' }],
        signal: new AbortController().signal,
        viewport: { width: 800, height: 600 },
        executeCommand: async () => ({ ok: true }),
        executeLocator: async () => ({ kind: 'done', value: undefined }),
      }),
    ).rejects.toThrow('recording click requires selector or (x,y)')
  })

  test('中止信号:预中止立即短路,wait 中止中途抛 AbortError', async () => {
    const controller = new AbortController()
    const view = makeView([])
    controller.abort()
    // 预中止:进入循环前即抛,不等待
    await expect(
      executeRecordingActions({
        view,
        actions: [{ type: 'wait', durationMs: 5_000 }],
        signal: controller.signal,
        viewport: { width: 800, height: 600 },
        executeCommand: async () => ({ ok: true }),
        executeLocator: async () => ({ kind: 'done', value: undefined }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // wait 挂起期间触发中止,不等待 5s
    const midController = new AbortController()
    setTimeout(() => midController.abort(), 20)
    await expect(
      executeRecordingActions({
        view,
        actions: [{ type: 'wait', durationMs: 5_000 }],
        signal: midController.signal,
        viewport: { width: 800, height: 600 },
        executeCommand: async () => ({ ok: true }),
        executeLocator: async () => ({ kind: 'done', value: undefined }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('光标 overlay 脚本', () => {
  function makeGuest(sink: string[], destroyed = false): WebContents {
    return {
      isDestroyed: () => destroyed,
      executeJavaScript: async (code: string) => {
        sink.push(code)
      },
    } as unknown as WebContents
  }

  test('安装脚本包含伪光标关键样式与监听', async () => {
    const sink: string[] = []
    await installRecordingCursorOverlay(makeGuest(sink))
    const script = sink[0] ?? ''
    expect(script).toContain('__zcode_browser_recording_cursor')
    expect(script).toContain('width:18px;height:18px')
    expect(script).toContain('background:#ff4d4f')
    expect(script).toContain('z-index:2147483647')
    expect(script).toContain('scale(.72)')
    expect(script).toContain('addEventListener("mousemove", move, true)')
    expect(script).toContain('addEventListener("mousedown", down, true)')
    expect(script).toContain('addEventListener("mouseup", up, true)')
  })

  test('移除脚本调用清理句柄;guest 已销毁时跳过', async () => {
    const sink: string[] = []
    await removeRecordingCursorOverlay(makeGuest(sink))
    expect(sink[0]).toBe('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
    await removeRecordingCursorOverlay(makeGuest(sink, true))
    expect(sink.length).toBe(1)
  })
})
