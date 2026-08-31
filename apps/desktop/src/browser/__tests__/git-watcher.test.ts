// git-watcher 测试：fs.watch → 60s 防抖（测试用短窗口）→ lume:browser-git-dirty
// 事件面。真实 fs 事件 + 可注入 debounceMs 驱动，不 mock fs.watch 本体。
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { GIT_PANEL_IPC_CHANNELS } from '@lume/shared'
import { createGitWorkspaceWatcher } from '../git-watcher'

/** 短防抖窗口（替代 60s，单测可承受）。 */
const DEBOUNCE_MS = 25
/** 等待防抖到期 + fs 事件送达的余量。 */
const SETTLE_MS = 300

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 带伪 .git 的工作区临时目录（.git 存在与否决定第二个 watch 是否建立）。 */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-watcher-test-'))
  mkdirSync(join(dir, '.git'))
  return dir
}

function createHarness() {
  const emitted: Array<{ method: string; params: Record<string, unknown> }> = []
  const warnings: Array<{ message: string; error?: unknown }> = []
  let windowAlive = true
  const watcher = createGitWorkspaceWatcher({
    emit: (event) => emitted.push(event),
    getWindow: () => (windowAlive ? {} as BrowserWindow : null),
    warn: (message, error) => warnings.push({ message, error }),
    debounceMs: DEBOUNCE_MS,
  })
  return {
    watcher,
    emitted,
    warnings,
    killWindow: () => { windowAlive = false },
  }
}

describe('createGitWorkspaceWatcher', () => {
  test('变更防抖到期后只发一次 dirty 事件', async () => {
    const { watcher, emitted } = createHarness()
    const workspace = makeWorkspace()
    try {
      watcher.watchWorkspace(workspace)
      writeFileSync(join(workspace, 'a.txt'), '1')
      writeFileSync(join(workspace, 'a.txt'), '2')
      writeFileSync(join(workspace, 'b.txt'), '1')
      await wait(SETTLE_MS)
      expect(emitted).toEqual([{ method: GIT_PANEL_IPC_CHANNELS.dirty, params: {} }])
    } finally {
      watcher.unwatchAll()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('watchWorkspace 替换旧监听：旧工作区变更不再触发', async () => {
    const { watcher, emitted } = createHarness()
    const first = makeWorkspace()
    const second = makeWorkspace()
    try {
      watcher.watchWorkspace(first)
      watcher.watchWorkspace(second)
      writeFileSync(join(first, 'stale.txt'), 'x')
      await wait(SETTLE_MS)
      expect(emitted).toEqual([])
      writeFileSync(join(second, 'fresh.txt'), 'x')
      await wait(SETTLE_MS)
      expect(emitted).toEqual([{ method: GIT_PANEL_IPC_CHANNELS.dirty, params: {} }])
    } finally {
      watcher.unwatchAll()
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('unwatchAll 后变更不再触发', async () => {
    const { watcher, emitted } = createHarness()
    const workspace = makeWorkspace()
    try {
      watcher.watchWorkspace(workspace)
      watcher.unwatchAll()
      writeFileSync(join(workspace, 'after.txt'), 'x')
      await wait(SETTLE_MS)
      expect(emitted).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('不存在的路径静默跳过不抛错（sidecar workspace-watcher 同口径）', () => {
    const { watcher, emitted, warnings } = createHarness()
    const missing = join(tmpdir(), 'git-watcher-test-missing-dir')
    rmSync(missing, { recursive: true, force: true })
    expect(() => watcher.watchWorkspace(missing)).not.toThrow()
    expect(emitted).toEqual([])
    expect(warnings.length).toBe(0)
  })

  test('无存活窗口时丢弃到期的 dirty 通知', async () => {
    const { watcher, emitted, killWindow } = createHarness()
    const workspace = makeWorkspace()
    try {
      watcher.watchWorkspace(workspace)
      killWindow()
      writeFileSync(join(workspace, 'hidden.txt'), 'x')
      await wait(SETTLE_MS)
      expect(emitted).toEqual([])
    } finally {
      watcher.unwatchAll()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
