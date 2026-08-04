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

const { BrowserAnnotationManager, sanitizeDeclarations } = await import('./browser-annotation-manager')
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

// Task 54：manager onGuestMessage design 分支（design-overlay-update/delete/submit）+
// sanitizeDeclarations 纯函数。design 分支由 overlay 触发（与 editor 分支对称）：
// anchor/declarations 从 store activeDesignChange 取（Task 53 已持久化），不依赖 overlay 二次传入。
describe('BrowserAnnotationManager design 消息', () => {
  test('design-overlay-update：setActiveDesignChange + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })

      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(snap.activeDesignChange?.id).toBe('dc1')
      expect(snap.activeDesignChange?.declarations).toEqual([{ property: 'color', value: 'red', previousValue: 'blue' }])
      // syncGuest 推送一次
      expect(send).toHaveBeenCalledTimes(1)
      // emitSnapshot 推送 annotation-state
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
    })
  })

  test('design-overlay-delete：clearActiveDesignChange + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 预置 activeDesignChange
      manager.store.setActiveDesignChange({
        threadId: 'thread-1', tabId: 'tab-1', url: ANCHOR.url, generation: 1,
        id: 'dc1', anchor: ANCHOR,
        declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
      })
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDesignChange).toBeDefined()

      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'design-overlay-delete',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1', groupId: 'dc1',
      })

      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDesignChange).toBeUndefined()
      expect(send).toHaveBeenCalledTimes(1)
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(true)
    })
  })

  test('design-submit send：saveDesignChange(declarations) + emit direct-submit + 清空 activeDesignChange + 落盘', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 预置 activeDesignChange（模拟 overlay 之前的 update）
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
      // 重置 calls（design-overlay-update 也 emit）
      calls.length = 0

      manager.onGuestMessage(newTab(), {
        type: 'design-submit', action: 'send', body: '改色',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      const direct = calls.filter((c) => c.method === 'browser:annotation-direct-submit')
      expect(direct).toHaveLength(1)
      const params = direct[0]!.params
      expect(params.threadId).toBe('thread-1')
      expect(params.tabId).toBe('tab-1')
      const attachment = params.attachment as {
        declarations: { property: string; value: string; previousValue: string }[]
        body: string
        groupId: string
        id: string
        originalStyles: Record<string, string>
        proposedStyles: Record<string, string>
        origin: string
      }
      expect(attachment.origin).toBe('browser-design-change')
      expect(attachment.id).toBe('dc1') // groupId === designChange.id
      expect(attachment.groupId).toBe('dc1')
      expect(attachment.declarations).toEqual([{ property: 'color', value: 'red', previousValue: 'blue' }])
      expect(attachment.body).toBe('改色')
      expect(attachment.originalStyles).toEqual({ color: 'blue' })
      expect(attachment.proposedStyles).toEqual({ color: 'red' })
      // send 不应同时触发 added
      expect(calls.some((c) => c.method === 'browser:annotation-added')).toBe(false)
      // 提交后 activeDesignChange 清空
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDesignChange).toBeUndefined()
      // 落盘：comments 含此 designChange（按 id）
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.map((c) => c.id)).toContain('dc1')
    })
  })

  test('design-submit add：emit annotation-added（不触发 direct-submit）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [] },
      })
      calls.length = 0

      manager.onGuestMessage(newTab(), {
        type: 'design-submit', action: 'add', body: '备注',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      const added = calls.filter((c) => c.method === 'browser:annotation-added')
      expect(added).toHaveLength(1)
      expect(calls.some((c) => c.method === 'browser:annotation-direct-submit')).toBe(false)
    })
  })

  test('design-submit 无 activeDesignChange：不 emit 语义事件', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      // 不预置 activeDesignChange → 提交早 return
      manager.onGuestMessage(newTab(), {
        type: 'design-submit', action: 'send', body: '改色',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      expect(calls.some((c) => c.method === 'browser:annotation-direct-submit')).toBe(false)
      expect(calls.some((c) => c.method === 'browser:annotation-added')).toBe(false)
    })
  })

  test('design-overlay-update 非法 group（缺 declarations）：静默 return', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR }, // 缺 declarations
      })
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).activeDesignChange).toBeUndefined()
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })

  // Task 74：Alt 多选（Codex §1.3）——design-overlay-update additionalAnchors 追加（非覆盖）。
  // host 是 additionalAnchors 单一来源；overlay 在 Alt+click 时把新 anchor 放进 group.additionalAnchors
  // 数组，manager sanitizeAnchor 后调 setActiveDesignChange 的 appendAdditionalAnchors。
  test('design-overlay-update 携带 additionalAnchors：sanitize + 追加到 activeDesignChange', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      // 预置 activeDesignChange（已有主 anchor）
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [] },
      })
      // Alt+click → design-overlay-update 携带 additionalAnchors（新 anchor）
      const additionalAnchor = { ...ANCHOR, selector: '#other' }
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [], additionalAnchors: [additionalAnchor] },
      })
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      // 追加而非覆盖；anchor 经 sanitizeAnchor 保留 selector
      expect(snap.activeDesignChange?.additionalAnchors).toHaveLength(1)
      expect(snap.activeDesignChange?.additionalAnchors?.[0]?.selector).toBe('#other')
    })
  })

  test('design-overlay-update additionalAnchors 多次：累计追加（非覆盖）', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [], additionalAnchors: [{ ...ANCHOR, selector: '#a' }] },
      })
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [], additionalAnchors: [{ ...ANCHOR, selector: '#b' }] },
      })
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      // 累计两条，非覆盖
      expect(snap.activeDesignChange?.additionalAnchors).toHaveLength(2)
      expect(snap.activeDesignChange?.additionalAnchors?.map((a) => a.selector)).toEqual(['#a', '#b'])
    })
  })

  test('design-overlay-update 不携带 additionalAnchors：保留现有（DesignEditor submit 不清空）', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      // 先 Alt+click 追加一条
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: { id: 'dc1', anchor: ANCHOR, declarations: [], additionalAnchors: [{ ...ANCHOR, selector: '#a' }] },
      })
      // 然后 DesignEditor submit（无 additionalAnchors 字段）
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        },
      })
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      // additionalAnchors 仍保留
      expect(snap.activeDesignChange?.additionalAnchors).toHaveLength(1)
      // declarations 是新值
      expect(snap.activeDesignChange?.declarations).toEqual([{ property: 'color', value: 'red', previousValue: 'blue' }])
    })
  })

  test('design-overlay-update additionalAnchors 非法 anchor（url mismatch）：过滤掉，不追加', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR, declarations: [],
          additionalAnchors: [{ ...ANCHOR, url: 'https://evil.test/' }], // url mismatch
        },
      })
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      // 非法 anchor 过滤，additionalAnchors 不存在
      expect(snap.activeDesignChange?.additionalAnchors).toBeUndefined()
    })
  })

  // Task 74：remove-annotation-selection —— manager 从 activeDesignChange.additionalAnchors 移除指定 index。
  test('remove-annotation-selection：按 selectionIndex 移除 + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      // 预置 activeDesignChange + 2 条 additionalAnchors
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR, declarations: [],
          additionalAnchors: [{ ...ANCHOR, selector: '#a' }, { ...ANCHOR, selector: '#b' }],
        },
      })
      calls.length = 0
      // 移除 index=0
      manager.onGuestMessage(newTab(send), {
        type: 'remove-annotation-selection', selectionIndex: 0,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(snap.activeDesignChange?.additionalAnchors).toHaveLength(1)
      expect(snap.activeDesignChange?.additionalAnchors?.[0]?.selector).toBe('#b')
      // syncGuest + emitSnapshot
      expect(send).toHaveBeenCalledTimes(1)
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(true)
    })
  })

  test('remove-annotation-selection 越界 index：静默 no-op', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'design-overlay-update',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
        group: {
          id: 'dc1', anchor: ANCHOR, declarations: [],
          additionalAnchors: [{ ...ANCHOR, selector: '#a' }],
        },
      })
      calls.length = 0
      manager.onGuestMessage(newTab(), {
        type: 'remove-annotation-selection', selectionIndex: 9,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      // 越界：additionalAnchors 不变；不 syncGuest/emit
      const snap = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(snap.activeDesignChange?.additionalAnchors).toHaveLength(1)
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })

  test('remove-annotation-selection 无 activeDesignChange：静默 no-op', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'remove-annotation-selection', selectionIndex: 0,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })
})

// Task 71：manager onGuestMessage 4 个交互命令（design-scrub-changed/set-design-modifier-pressed/
// set-original-view-enabled/tweaks-open-changed）+ store.setDesignFlags + syncGuest 推送。
// 5c 简化：design-scrub-changed 为 no-op（对齐 Codex scrub 结束不发消息，overlay 本地 scrub 状态）。
// 其余 3 命令 → store.setDesignFlags（合并字段）+ syncGuest + emitSnapshot。syncGuest 必须把
// 布尔 false 也推送给 guest（与 theme 不同——theme 仅 truthy 推送；这里用 !== undefined 守卫）。
describe('BrowserAnnotationManager design 交互命令（Task 71）', () => {
  test('set-design-modifier-pressed true：store.isDesignModifierPressed + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'set-design-modifier-pressed', pressed: true,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // store 字段更新
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).isDesignModifierPressed).toBe(true)
      // syncGuest 推送一次（payload 携带 isDesignModifierPressed=true）
      expect(send).toHaveBeenCalledTimes(1)
      const syncPayload = send.mock.calls[0]![1] as { isDesignModifierPressed?: boolean }
      expect(syncPayload.isDesignModifierPressed).toBe(true)
      // emitSnapshot
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
      expect((states[0]!.params as { isDesignModifierPressed?: boolean }).isDesignModifierPressed).toBe(true)
    })
  })

  test('set-design-modifier-pressed false：store 保留 false（非 undefined）+ syncGuest 推送 false', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'set-design-modifier-pressed', pressed: false,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // 关键：false 必须作为字面量保留（key released 事件），不能被 ?? undefined 吃掉
      const after = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(after.isDesignModifierPressed).toBe(false)
      const syncPayload = send.mock.calls[0]![1] as { isDesignModifierPressed?: boolean }
      expect(syncPayload.isDesignModifierPressed).toBe(false)
    })
  })

  test('set-original-view-enabled：store.isOriginalViewEnabled + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'set-original-view-enabled', enabled: true,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).isOriginalViewEnabled).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      const syncPayload = send.mock.calls[0]![1] as { isOriginalViewEnabled?: boolean }
      expect(syncPayload.isOriginalViewEnabled).toBe(true)
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
      expect((states[0]!.params as { isOriginalViewEnabled?: boolean }).isOriginalViewEnabled).toBe(true)
    })
  })

  test('tweaks-open-changed：store.isTweaksEditorOpen + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'tweaks-open-changed', open: true,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).isTweaksEditorOpen).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      const syncPayload = send.mock.calls[0]![1] as { isTweaksEditorOpen?: boolean }
      expect(syncPayload.isTweaksEditorOpen).toBe(true)
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
      expect((states[0]!.params as { isTweaksEditorOpen?: boolean }).isTweaksEditorOpen).toBe(true)
    })
  })

  test('design-scrub-changed：no-op（不写 store、不 syncGuest、不 emitSnapshot）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const send = mock(() => {})
      manager.onGuestMessage(newTab(send), {
        type: 'design-scrub-changed', property: 'color', value: 'red',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // 5c 简化：scrub 实时值由 overlay 本地维护，manager 不存（declarations 仍在 activeDesignChange）
      expect(send).not.toHaveBeenCalled()
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })

  test('setDesignFlags 合并语义：多命令分次设置互不覆盖', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      // 先设 modifier
      manager.onGuestMessage(newTab(), {
        type: 'set-design-modifier-pressed', pressed: true,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      // 再设 original-view
      manager.onGuestMessage(newTab(), {
        type: 'set-original-view-enabled', enabled: true,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      // 两个字段都保留（合并而非覆盖）
      const after = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      expect(after.isDesignModifierPressed).toBe(true)
      expect(after.isOriginalViewEnabled).toBe(true)
      // 未设置的字段仍是 undefined
      expect(after.isTweaksEditorOpen).toBeUndefined()
    })
  })

  test('L121 守卫对 set-design-modifier-pressed 同样生效（tabId mismatch → 早 return）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'set-design-modifier-pressed', pressed: true,
        tabId: 'other-tab', generation: 1, threadId: 'thread-1',
      })

      // 守卫位于 type 分派之前，mismatch 时早 return
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
      expect(manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).isDesignModifierPressed).toBeUndefined()
    })
  })
})

// Task 94：manager 公共 resolve/markRead 方法 + onGuestMessage resolve/mark-read 处理。
// host 评审面板 CommentList 的回调 → IPC → browser-runtime dispatch → this.resolve/markRead；
// overlay guest → onGuestMessage {type:'resolve'|'mark-read'} → 同样落 store。两条路径对称。
describe('BrowserAnnotationManager resolve / mark-read', () => {
  test('resolve：store.resolveComment 翻 isResolved + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const commentId = 'browser-annotation:r1'
      manager.store.saveComment({
        id: commentId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: '请解决',
      })

      const send = mock(() => {})
      const snapshot = manager.resolve(newTab(send), 'thread-1', commentId, 'user')

      // store 翻字段
      const after = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1)
      const target = after.comments.find((c) => c.id === commentId)!
      expect(target.isResolved).toBe(true)
      expect(target.resolvedBy).toBe('user')
      expect(typeof target.resolvedAt).toBe('string')
      // 返回值是同一 snapshot
      expect(snapshot.comments.find((c) => c.id === commentId)?.isResolved).toBe(true)
      // syncGuest + emitSnapshot 各一次
      expect(send).toHaveBeenCalledTimes(1)
      const states = calls.filter((c) => c.method === 'browser:annotation-state')
      expect(states).toHaveLength(1)
    })
  })

  test('markRead：store.markRead 写 readAt + syncGuest + emitSnapshot', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      const commentId = 'browser-annotation:r1'
      manager.store.saveComment({
        id: commentId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: '请已读',
      })

      const send = mock(() => {})
      manager.markRead(newTab(send), 'thread-1', commentId)

      const target = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.find((c) => c.id === commentId)!
      expect(typeof target.readAt).toBe('string')
      expect(send).toHaveBeenCalledTimes(1)
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(true)
    })
  })

  test('resolve 默认 resolvedBy=user（host 面板触发场景）', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      const commentId = 'browser-annotation:r1'
      manager.store.saveComment({
        id: commentId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: '默认',
      })

      manager.resolve(newTab(), 'thread-1', commentId)

      const target = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.find((c) => c.id === commentId)!
      expect(target.resolvedBy).toBe('user')
    })
  })

  test('onGuestMessage resolve：调 this.resolve + resolvedBy 收敛 user', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      const commentId = 'browser-annotation:r1'
      manager.store.saveComment({
        id: commentId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: 'guest resolve',
      })

      manager.onGuestMessage(newTab(), {
        type: 'resolve', annotationId: commentId,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      const target = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.find((c) => c.id === commentId)!
      expect(target.isResolved).toBe(true)
      expect(target.resolvedBy).toBe('user') // overlay 触发也收敛 user
    })
  })

  test('onGuestMessage mark-read：调 this.markRead', () => {
    withDirectory((directory) => {
      const { manager } = newManager(directory)
      const commentId = 'browser-annotation:r1'
      manager.store.saveComment({
        id: commentId,
        origin: 'browser-annotation',
        tab: { id: 'browser-tab:tab-1:1', origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: 'tab-1', title: 'Example', url: ANCHOR.url, generation: 1, ownerThreadId: 'thread-1' },
        anchor: ANCHOR,
        body: 'guest mark-read',
      })

      manager.onGuestMessage(newTab(), {
        type: 'mark-read', annotationId: commentId,
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })

      const target = manager.store.get('thread-1', 'tab-1', ANCHOR.url, 1).comments.find((c) => c.id === commentId)!
      expect(typeof target.readAt).toBe('string')
    })
  })

  test('onGuestMessage resolve 无 annotationId：no-op（不调 this.resolve，不 emit）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'resolve',
        tabId: 'tab-1', generation: 1, threadId: 'thread-1',
      })
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })

  test('onGuestMessage L121 守卫对 resolve 同样生效（tabId mismatch → 早 return）', () => {
    withDirectory((directory) => {
      const { manager, calls } = newManager(directory)
      manager.onGuestMessage(newTab(), {
        type: 'resolve', annotationId: 'any',
        tabId: 'other-tab', generation: 1, threadId: 'thread-1',
      })
      expect(calls.some((c) => c.method === 'browser:annotation-state')).toBe(false)
    })
  })
})

describe('sanitizeDeclarations', () => {
  test('过滤非法 property + 缺 previousValue，保留合法项', () => {
    expect(sanitizeDeclarations([
      { property: 'color', value: 'red', previousValue: 'blue' },
      { property: 'bad prop', value: 'x', previousValue: 'y' }, // property 含空格，过滤
      { property: 'ok', value: 'v' }, // 缺 previousValue，过滤
    ])).toEqual([{ property: 'color', value: 'red', previousValue: 'blue' }])
  })

  test('非数组入参 → 空数组', () => {
    expect(sanitizeDeclarations(undefined)).toEqual([])
    expect(sanitizeDeclarations({})).toEqual([])
    expect(sanitizeDeclarations('not-array')).toEqual([])
  })

  test('保留 placeholderValue（可选），截断 value/previousValue 至 4096', () => {
    const long = 'x'.repeat(5000)
    const result = sanitizeDeclarations([
      { property: 'color', value: long, previousValue: 'blue', placeholderValue: long },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.value.length).toBe(4096)
    expect(result[0]!.previousValue).toBe('blue')
    expect(result[0]!.placeholderValue?.length).toBe(4096)
  })

  test('截断 declarations 至 64 条（cap）', () => {
    // 正则 [a-zA-Z][a-zA-Z0-9-]{0,127} 允许首字母后接数字/字母/连字符，故 p0/p1.. 均合法
    const valid = Array.from({ length: 70 }, (_, i) => ({ property: `p${i}`, value: 'v', previousValue: 'o' }))
    const result = sanitizeDeclarations(valid)
    expect(result).toHaveLength(64)
    expect(result[0]!.property).toBe('p0')
    expect(result[63]!.property).toBe('p63')
    // 第 64+ 被丢
    expect(result.some((d) => d.property === 'p64')).toBe(false)
    // 数字开头的 property 非法，全部被滤
    const illegal = Array.from({ length: 5 }, (_, i) => ({ property: `${i}abc`, value: 'v', previousValue: 'o' }))
    expect(sanitizeDeclarations(illegal)).toEqual([])
  })
})
