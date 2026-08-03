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
})
