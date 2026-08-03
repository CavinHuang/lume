// Task 43: manager onGuestMessage editor 命令（editor-submit/cancel/delete）的 TDD 测试。
// 编辑器分支走 store+syncGuest+emit，不调 BrowserWindow/popup，故 getParentWindow→null 即可。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, mock, test } from 'bun:test'

// manager 在模块加载期从 electron 导入 BrowserWindow/screen；编辑器分支不会触发它们，
// 但模块必须能加载。bun:test 的 mock.module 在单次 bun test 运行内跨文件共享且首写胜出，
// 故所有 desktop 测试共享同一个 superset stub（见 scripts/test-electron-mock.ts），
// 覆盖 manager 的 BrowserWindow/screen 与 overlay 测试的 ipcRenderer 等。
import { electronMockStub } from '../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

const { BrowserAnnotationManager } = await import('./browser-annotation-manager')
// 通过 InstanceType<typeof ...> 取实例类型，再推导 onGuestMessage 第一个参数（AnnotationRuntimeTab）。
type AnnotationRuntimeTab = Parameters<InstanceType<typeof BrowserAnnotationManager>['onGuestMessage']>[0]

const ANCHOR = {
  kind: 'element' as const,
  url: 'https://example.test/',
  generation: 1,
  framePath: [],
  selector: '#main',
  rect: { x: 10, y: 20, width: 100, height: 40 },
}

function newTab(send: (channel: string, payload: unknown) => void = () => {}): AnnotationRuntimeTab {
  return {
    tabId: 'tab-1',
    backend: 'iab',
    generation: 1,
    url: ANCHOR.url,
    title: 'Example',
    visible: true,
    surface: 'main',
    ownerThreadId: 'thread-1',
    webContents: { send, isDestroyed: () => false },
  } as unknown as AnnotationRuntimeTab
}

function newManager(directory: string) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const emit = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }) }
  const manager = new BrowserAnnotationManager({
    configDir: () => directory,
    getParentWindow: () => null,
    annotationPopupPreloadPath: join(directory, 'preload.js'),
    rendererUrl: () => 'http://localhost:8080',
    emit,
    getScreenshotMode: () => 'off',
    captureScreenshot: () => Promise.resolve({ data: Buffer.alloc(0) }),
  })
  return { manager, calls }
}

function withDirectory<T>(fn: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'lume-manager-editor-'))
  try { return fn(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('BrowserAnnotationManager editor 命令', () => {
  test('editor-submit add：从 activeDraft 取 anchor → saveAttachment → emit annotation-added', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 预置 activeDraft（anchor 来自 store，overlay 不传 anchor）
      manager.store.setDraft({
        threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
        anchor: ANCHOR, body: '',
      })
      manager.onGuestMessage(newTab(), {
        type: 'editor-submit', action: 'add', body: 'hello',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // saveAttachment 内部先 emit annotation-state，再 emit annotation-added
      const added = calls.filter((c) => c.method === 'browser:annotation-added')
      expect(added).toHaveLength(1)
      const params = added[0]!.params
      expect(params.threadId).toBe('thread-1')
      expect(params.tabId).toBe('tab-1')
      const attachment = params.attachment as { body: string; anchor: typeof ANCHOR; id: string }
      expect(attachment.body).toBe('hello')
      expect(attachment.anchor).toEqual(ANCHOR) // anchor 来自 store activeDraft，单一来源
      expect(attachment.id).toMatch(/^browser-annotation:/) // 新建 id
      // 保存后 activeDraft 清空，comment 入库
      const after = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(after.activeDraft).toBeUndefined()
      expect(after.comments.map((c) => c.body)).toContain('hello')
    })
  })

  test('editor-submit send：emit annotation-direct-submit（不触发 annotation-added）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.store.setDraft({
        threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
        anchor: ANCHOR, body: '',
      })
      manager.onGuestMessage(newTab(), {
        type: 'editor-submit', action: 'send', body: 'send it',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      const direct = calls.filter((c) => c.method === 'browser:annotation-direct-submit')
      expect(direct).toHaveLength(1)
      expect((direct[0]!.params.attachment as { body: string }).body).toBe('send it')
      // send 不应同时触发 added
      expect(calls.some((c) => c.method === 'browser:annotation-added')).toBe(false)
    })
  })

  test('editor-submit 无 activeDraft：不保存不 emit 语义事件', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 不 setDraft → store.get().activeDraft 为 undefined
      manager.onGuestMessage(newTab(), {
        type: 'editor-submit', action: 'add', body: 'hi',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      expect(calls.some((c) => c.method === 'browser:annotation-added')).toBe(false)
      expect(calls.some((c) => c.method === 'browser:annotation-direct-submit')).toBe(false)
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments).toHaveLength(0)
    })
  })

  test('editor-cancel：store.clearDraft + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.store.setDraft({
        threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
        anchor: ANCHOR, body: 'draft',
      })
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDraft).toBeDefined()

      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'editor-cancel',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // activeDraft 被清空
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDraft).toBeUndefined()
      // syncGuest：webContents.send 被调一次（推送 sync 给 guest）
      expect(send).toHaveBeenCalledTimes(1)
      // emitSnapshot：emit 'browser:annotation-state' 一次，且 payload.activeDraft 为 undefined
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
      expect((states[0]!.params as { activeDraft?: unknown }).activeDraft).toBeUndefined()
    })
  })

  test('editor-delete：activeDraft.id 存在 → this.delete(tab, threadId, id) 删除该注释', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 预置一条已保存 comment，再 setDraft 指向它（编辑场景）
      const existingId = 'browser-annotation:existing-1'
      manager.store.saveComment({
        id: existingId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: '旧批注',
      })
      manager.store.setDraft({
        threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
        id: existingId, anchor: ANCHOR, body: '旧批注',
      })
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.map((c) => c.id)).toContain(existingId)

      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'editor-delete',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // comment 被删除
      const after = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(after.comments.map((c) => c.id)).not.toContain(existingId)
      expect(after.comments).toHaveLength(0)
      // this.delete 内部 syncGuest + emitSnapshot
      expect(send).toHaveBeenCalledTimes(1)
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(true)
    })
  })

  // Task 44：onGuestMessage L121 守卫（tabId/generation/threadId 对齐）对 editor-submit 同样生效。
  // 守卫位于 type 分派之前，故 mismatch 时 editor-submit 提前 return，不调 saveAttachment。
  // 覆盖三条字段各 mismatch 一次，验证守卫非「仅校验 type 字符串」。
  // 注：tabId/generation mismatch 是关键——editor-submit 内部用 tab.tabId/tab.generation 查
  // store，若无守卫会命中本 tab 的 activeDraft 并保存；threadId mismatch 即便无守卫也会因
  // store.get(payload.threadId) 取到空 session 而早 return，但仍纳入以文档化守卫契约。
  const mismatchCases: Array<readonly [string, { tabId: string; generation: number; threadId: string }]> = [
    ['tabId', { tabId: 'other-tab', generation: 1, threadId: 'thread-1' }],
    ['generation', { tabId: 'tab-1', generation: 2, threadId: 'thread-1' }],
    ['threadId', { tabId: 'tab-1', generation: 1, threadId: 'other-thread' }],
  ]
  for (const [field, mismatch] of mismatchCases) {
    test(`editor-submit ${field} mismatch → L121 守卫提前 return → 不调 saveAttachment`, () => {
      withDirectory((directory) => {
        const { manager, calls } = newManager(directory)
        // 预置 activeDraft（否则即使绕过守卫也会因无 draft 早 return，掩盖守卫生效）
        manager.store.setDraft({
          threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
          anchor: ANCHOR, body: '',
        })

        manager.onGuestMessage(newTab(), {
          type: 'editor-submit', action: 'add', body: 'should not save',
          ...mismatch,
        })

        // 守卫提前 return：无语义事件、无 snapshot emit、无 syncGuest、comment 未入库
        expect(calls.some((c) => c.method === 'browser:annotation-added')).toBe(false)
        expect(calls.some((c) => c.method === 'browser:annotation-direct-submit')).toBe(false)
        expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
        expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments).toHaveLength(0)
      })
    })
  }
})
