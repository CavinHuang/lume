import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BrowserAnnotationSessionStore } from './browser-annotation-session'

const anchor = { kind: 'element' as const, url: 'https://example.test/', generation: 1, framePath: [], selector: '#main', rect: { x: 10, y: 20, width: 100, height: 40 } }

function attachment(id: string, body = 'Fix this', url = anchor.url) {
  return {
    id,
    origin: 'browser-annotation' as const,
    tab: { id: 'tab-1', origin: 'browser-tab' as const, backend: 'iab' as const, browserId: 'lume-iab' as const, tabId: 'tab-1', title: 'Example', url, generation: 1, ownerThreadId: 'thread-1' },
    anchor: { ...anchor, url },
    body,
  }
}

describe('BrowserAnnotationSessionStore', () => {
  test('bounds v2 sessions and replaces an edited comment by id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const store = new BrowserAnnotationSessionStore(() => directory)
      store.saveComment(attachment('comment-1'))
      store.saveComment(attachment('comment-1', 'Updated'))
      const snapshot = store.get('thread-1', 'tab-1', anchor.url, 1)
      expect(snapshot.comments).toHaveLength(1)
      expect(snapshot.comments[0]?.body).toBe('Updated')
      expect(JSON.parse(readFileSync(join(directory, 'browser', 'annotation-sessions-v2.json'), 'utf8'))['thread-1\u0000tab-1'].version).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('imports legacy review items and ignores duplicate ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const store = new BrowserAnnotationSessionStore(() => directory)
      const legacy = { 'thread-1:tab-1': { ownerThreadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1, items: [{ id: 'item-1', attachment: attachment('comment-1') }] } }
      expect(store.importLegacy(legacy)).toBe(1)
      expect(store.importLegacy(legacy)).toBe(0)
      expect(store.get('thread-1', 'tab-1', anchor.url, 1).comments).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('attaches screenshot metadata to the current comments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const store = new BrowserAnnotationSessionStore(() => directory)
      store.saveComment(attachment('comment-1'))
      const snapshot = store.setScreenshot('thread-1', 'tab-1', anchor.url, 1, { ref: 'browser-review-screenshot:thread-1:image', mode: 'necessary', width: 800, height: 600, deviceScaleFactor: 1 })
      expect(snapshot.screenshotRef).toBe('browser-review-screenshot:thread-1:image')
      expect(snapshot.comments[0]?.screenshot?.width).toBe(800)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('keeps comments from other URLs in one tab while clearing only the current URL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const store = new BrowserAnnotationSessionStore(() => directory)
      const otherUrl = 'https://example.test/other'
      store.saveComment(attachment('current', 'Current'))
      store.saveComment(attachment('other', 'Other', otherUrl))
      const cleared = store.clearComments('thread-1', 'tab-1', anchor.url, 99)
      expect(cleared.comments.map((comment) => comment.id)).toEqual(['other'])
      expect(store.get('thread-1', 'tab-1', otherUrl, 100).comments.map((comment) => comment.id)).toEqual(['other'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('assigns screenshot metadata only to current URL comments and restores counts across generations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const store = new BrowserAnnotationSessionStore(() => directory)
      const otherUrl = 'https://example.test/other'
      store.saveComment(attachment('current', 'Current'))
      store.saveComment(attachment('other', 'Other', otherUrl))
      const screenshot = store.setScreenshot('thread-1', 'tab-1', anchor.url, 7, { ref: 'browser-review-screenshot:thread-1:11111111-1111-4111-8111-111111111111', mode: 'necessary' })
      expect(screenshot.comments.find((comment) => comment.id === 'current')?.screenshotRef).toBeTruthy()
      expect(screenshot.comments.find((comment) => comment.id === 'other')?.screenshotRef).toBeUndefined()
      expect(store.get('thread-1', 'tab-1', anchor.url, 8).comments).toHaveLength(2)
      expect(store.get('thread-1', 'tab-1', anchor.url, 8).screenshotRef).toBe(screenshot.screenshotRef)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('restored sessions always return to browse mode without a draft', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
    try {
      const first = new BrowserAnnotationSessionStore(() => directory)
      first.saveComment(attachment('comment-1'))
      first.setMode('thread-1', 'tab-1', anchor.url, 1, 'comment')
      const restored = new BrowserAnnotationSessionStore(() => directory).get('thread-1', 'tab-1', anchor.url, 1)
      expect(restored.mode).toBe('browse')
      expect(restored.activeDraft).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  describe('activeDesignChange', () => {
    test('setActiveDesignChange 写入 activeDesignChange + mode=comment', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const snap = store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        })
        expect(snap.activeDesignChange).toEqual({
          id: 'dc-1', anchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        })
        expect(snap.mode).toBe('comment')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('clearActiveDesignChange 移除 activeDesignChange', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
        })
        const snap = store.clearActiveDesignChange('thread-1', 'tab-1', anchor.url, 1)
        expect(snap.activeDesignChange).toBeUndefined()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('get 透传 activeDesignChange', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
        })
        expect(store.get('thread-1', 'tab-1', anchor.url, 1).activeDesignChange?.id).toBe('dc-1')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('restore 重置时清空 activeDesignChange', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const first = new BrowserAnnotationSessionStore(() => directory)
        first.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
        })
        const restored = new BrowserAnnotationSessionStore(() => directory).get('thread-1', 'tab-1', anchor.url, 1)
        expect(restored.activeDesignChange).toBeUndefined()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    // Task 74：Alt 多选（Codex §1.3）——additionalAnchors 追加语义 + removeAnnotationSelection。
    // host 是 additionalAnchors 单一来源；setActiveDesignChange 在缺省时保留现有 additionalAnchors，
    // 在传入 appendAdditionalAnchors 时追加（非覆盖）。removeAnnotationSelection 按 index 移除。
    test('setActiveDesignChange 缺省保留现有 additionalAnchors（DesignEditor submit 不清空）', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const anchorB = { ...anchor, selector: '#b' }
        // 预置 activeDesignChange 含 additionalAnchors（模拟 Alt+click 已追加）
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
          appendAdditionalAnchors: [anchorB],
        })
        // 再 setActiveDesignChange（DesignEditor submit，无 appendAdditionalAnchors）
        const snap = store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor,
          declarations: [{ property: 'color', value: 'red', previousValue: 'blue' }],
        })
        // additionalAnchors 仍保留
        expect(snap.activeDesignChange?.additionalAnchors).toEqual([anchorB])
        // declarations 是新值
        expect(snap.activeDesignChange?.declarations).toEqual([{ property: 'color', value: 'red', previousValue: 'blue' }])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('setActiveDesignChange 传入 appendAdditionalAnchors → 追加（非覆盖）', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const anchorB = { ...anchor, selector: '#b' }
        const anchorC = { ...anchor, selector: '#c' }
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
          appendAdditionalAnchors: [anchorB],
        })
        const snap = store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
          appendAdditionalAnchors: [anchorC],
        })
        // 追加而非覆盖：[anchorB, anchorC]
        expect(snap.activeDesignChange?.additionalAnchors).toEqual([anchorB, anchorC])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('removeAnnotationSelection：按 selectionIndex 移除指定 anchor', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const anchorB = { ...anchor, selector: '#b' }
        const anchorC = { ...anchor, selector: '#c' }
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
          appendAdditionalAnchors: [anchorB, anchorC],
        })
        const snap = store.removeAnnotationSelection({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          selectionIndex: 0,
        })
        // 移除 index=0（anchorB），剩 anchorC
        expect(snap.activeDesignChange?.additionalAnchors).toEqual([anchorC])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('removeAnnotationSelection：越界 index 静默 no-op（不写盘）', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const anchorB = { ...anchor, selector: '#b' }
        store.setActiveDesignChange({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          id: 'dc-1', anchor, declarations: [],
          appendAdditionalAnchors: [anchorB],
        })
        // 越界 index=5
        const snap = store.removeAnnotationSelection({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          selectionIndex: 5,
        })
        // additionalAnchors 不变
        expect(snap.activeDesignChange?.additionalAnchors).toEqual([anchorB])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('removeAnnotationSelection：无 activeDesignChange 静默 no-op', () => {
      const directory = mkdtempSync(join(tmpdir(), 'lume-annotation-'))
      try {
        const store = new BrowserAnnotationSessionStore(() => directory)
        const snap = store.removeAnnotationSelection({
          threadId: 'thread-1', tabId: 'tab-1', url: anchor.url, generation: 1,
          selectionIndex: 0,
        })
        expect(snap.activeDesignChange).toBeUndefined()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
})
