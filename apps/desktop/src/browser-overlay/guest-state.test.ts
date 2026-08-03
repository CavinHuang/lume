// TDD tests for sanitizeSync (pure validator). createGuestBridge wraps
// ipcRenderer so it is not unit-testable without an electron mock — skipped.
import { describe, test, expect, mock } from 'bun:test'

// guest-state.ts imports 'electron' for ipcRenderer at module load.
// 注册共享 superset stub（bun:test 默认共享模式下 mock.module 首写胜出，所有
// 测试必须注册同一 stub）：本文件只用 sanitizeSync（纯函数），ipcRenderer 不被调用。
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

const { sanitizeSync } = await import('./guest-state')
type GuestState = import('./guest-state').GuestState

const validBase = {
  type: 'sync' as const,
  tabId: 'tab-1',
  generation: 1,
  threadId: 'thread-1',
}

describe('sanitizeSync - valid input', () => {
  test('valid sync returns GuestState with all fields', () => {
    const result = sanitizeSync({
      ...validBase,
      mode: 'comment',
      purpose: 'tweaks',
      theme: 'red',
      comments: [{ id: 'c1' }, { id: 'c2' }],
      activeDraft: { id: 'draft', body: 'hi' },
    })
    expect(result).toEqual({
      tabId: 'tab-1',
      generation: 1,
      threadId: 'thread-1',
      mode: 'comment',
      purpose: 'tweaks',
      theme: 'red',
      comments: [{ id: 'c1' }, { id: 'c2' }],
      activeDraft: { id: 'draft', body: 'hi' },
    } satisfies GuestState)
  })

  test('restore type accepted same as sync', () => {
    const result = sanitizeSync({ ...validBase, type: 'restore' })
    expect(result).not.toBeNull()
    expect(result?.tabId).toBe('tab-1')
    expect(result?.generation).toBe(1)
  })

  test('mode defaults to browse when missing or unknown', () => {
    expect(sanitizeSync(validBase)?.mode).toBe('browse')
    expect(sanitizeSync({ ...validBase, mode: 'something-else' })?.mode).toBe('browse')
  })

  test('mode comment preserved', () => {
    expect(sanitizeSync({ ...validBase, mode: 'comment' })?.mode).toBe('comment')
  })

  test('purpose defaults to annotation when missing or unknown', () => {
    expect(sanitizeSync(validBase)?.purpose).toBe('annotation')
    expect(sanitizeSync({ ...validBase, purpose: 'weird' })?.purpose).toBe('annotation')
  })

  test('purpose tweaks preserved', () => {
    expect(sanitizeSync({ ...validBase, purpose: 'tweaks' })?.purpose).toBe('tweaks')
  })

  test('activeDraft omitted when null / missing / non-object', () => {
    expect(sanitizeSync(validBase)?.activeDraft).toBeUndefined()
    expect(sanitizeSync({ ...validBase, activeDraft: null })?.activeDraft).toBeUndefined()
    expect(sanitizeSync({ ...validBase, activeDraft: 'str' })?.activeDraft).toBeUndefined()
  })

  test('activeDraft object preserved as-is (no nested validation in this layer)', () => {
    const draft = { foo: 'bar', n: 3 }
    expect(sanitizeSync({ ...validBase, activeDraft: draft })?.activeDraft).toEqual(draft)
  })
})

describe('sanitizeSync - non-object / wrong type', () => {
  test('null / undefined / primitive return null', () => {
    expect(sanitizeSync(null)).toBeNull()
    expect(sanitizeSync(undefined)).toBeNull()
    expect(sanitizeSync('hello')).toBeNull()
    expect(sanitizeSync(42)).toBeNull()
    expect(sanitizeSync(true)).toBeNull()
  })

  test('array (not record) returns null', () => {
    expect(sanitizeSync([1, 2, 3])).toBeNull()
  })

  test('missing type returns null', () => {
    const { type, ...rest } = validBase
    expect(sanitizeSync(rest)).toBeNull()
  })

  test('type close returns null (close handled by bridge, not sanitizeSync)', () => {
    expect(sanitizeSync({ type: 'close' })).toBeNull()
    expect(sanitizeSync({ ...validBase, type: 'close' })).toBeNull()
  })

  test('type prepare-screenshot returns null', () => {
    expect(sanitizeSync({ ...validBase, type: 'prepare-screenshot' })).toBeNull()
  })

  test('unknown type returns null', () => {
    expect(sanitizeSync({ ...validBase, type: 'nonsense' })).toBeNull()
  })
})

describe('sanitizeSync - tabId validation', () => {
  test('empty tabId returns null', () => {
    expect(sanitizeSync({ ...validBase, tabId: '' })).toBeNull()
  })
  test('non-string tabId returns null', () => {
    expect(sanitizeSync({ ...validBase, tabId: 123 })).toBeNull()
    expect(sanitizeSync({ ...validBase, tabId: null })).toBeNull()
  })
  test('tabId > 256 chars returns null', () => {
    expect(sanitizeSync({ ...validBase, tabId: 'a'.repeat(257) })).toBeNull()
  })
  test('256-char tabId accepted (boundary)', () => {
    expect(sanitizeSync({ ...validBase, tabId: 'a'.repeat(256) })?.tabId.length).toBe(256)
  })
})

describe('sanitizeSync - generation validation', () => {
  test('non-number returns null', () => {
    expect(sanitizeSync({ ...validBase, generation: '1' })).toBeNull()
    expect(sanitizeSync({ ...validBase, generation: null })).toBeNull()
  })
  test('non-integer returns null', () => {
    expect(sanitizeSync({ ...validBase, generation: 1.5 })).toBeNull()
    expect(sanitizeSync({ ...validBase, generation: NaN })).toBeNull()
  })
  test('< 1 returns null', () => {
    expect(sanitizeSync({ ...validBase, generation: 0 })).toBeNull()
    expect(sanitizeSync({ ...validBase, generation: -3 })).toBeNull()
  })
  test('> 2_000_000 returns null', () => {
    expect(sanitizeSync({ ...validBase, generation: 2_000_001 })).toBeNull()
  })
  test('boundary 1 and 2_000_000 accepted', () => {
    expect(sanitizeSync({ ...validBase, generation: 1 })?.generation).toBe(1)
    expect(sanitizeSync({ ...validBase, generation: 2_000_000 })?.generation).toBe(2_000_000)
  })
})

describe('sanitizeSync - threadId validation', () => {
  test('bad chars reject (space, slash, unicode)', () => {
    expect(sanitizeSync({ ...validBase, threadId: 'has space' })).toBeNull()
    expect(sanitizeSync({ ...validBase, threadId: 'has/slash' })).toBeNull()
    expect(sanitizeSync({ ...validBase, threadId: 'café' })).toBeNull()
    expect(sanitizeSync({ ...validBase, threadId: 'has#hash' })).toBeNull()
  })
  test('non-string returns null', () => {
    expect(sanitizeSync({ ...validBase, threadId: 42 })).toBeNull()
  })
  test('empty returns null', () => {
    expect(sanitizeSync({ ...validBase, threadId: '' })).toBeNull()
  })
  test('> 200 chars returns null', () => {
    expect(sanitizeSync({ ...validBase, threadId: 'a'.repeat(201) })).toBeNull()
  })
  test('alphanumeric + . _ - allowed', () => {
    expect(sanitizeSync({ ...validBase, threadId: 'abc.123_X-Y' })?.threadId).toBe('abc.123_X-Y')
  })
  test('200-char threadId accepted (boundary)', () => {
    expect(sanitizeSync({ ...validBase, threadId: 'a'.repeat(200) })?.threadId.length).toBe(200)
  })
})

describe('sanitizeSync - comments', () => {
  test('missing comments → []', () => {
    expect(sanitizeSync(validBase)?.comments).toEqual([])
  })
  test('non-array comments → []', () => {
    expect(sanitizeSync({ ...validBase, comments: 'not-array' })?.comments).toEqual([])
    expect(sanitizeSync({ ...validBase, comments: { a: 1 } })?.comments).toEqual([])
    expect(sanitizeSync({ ...validBase, comments: null })?.comments).toEqual([])
  })
  test('capped at 100 (drops overflow)', () => {
    const comments = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}` }))
    const result = sanitizeSync({ ...validBase, comments })
    expect(result?.comments.length).toBe(100)
    expect(result?.comments[0]).toEqual({ id: 'c0' })
    expect(result?.comments[99]).toEqual({ id: 'c99' })
  })
  test('non-object items filtered out, objects kept', () => {
    const result = sanitizeSync({
      ...validBase,
      comments: [{ id: 'c1' }, 'junk', 42, null, false, undefined, { id: 'c2' }],
    })
    expect(result?.comments).toEqual([{ id: 'c1' }, { id: 'c2' }])
  })
})

describe('sanitizeSync - theme', () => {
  test('color rejected by CSS.supports is omitted', () => {
    // happy-dom's CSS.supports is permissive (always true). Real Chromium
    // returns false for invalid colors. Override the global to exercise the
    // rejection branch in sanitizeSync.
    const orig = (globalThis as unknown as { CSS: { supports: (prop: string, val: string) => boolean } }).CSS.supports
    ;(globalThis as unknown as { CSS: { supports: (prop: string, val: string) => boolean } }).CSS.supports = (_prop, val) => val === 'red'
    try {
      expect(sanitizeSync({ ...validBase, theme: 'red' })?.theme).toBe('red')
      expect(sanitizeSync({ ...validBase, theme: 'not-a-color' })?.theme).toBeUndefined()
    } finally {
      ;(globalThis as unknown as { CSS: { supports: (prop: string, val: string) => boolean } }).CSS.supports = orig
    }
  })
  test('non-string theme omitted', () => {
    expect(sanitizeSync({ ...validBase, theme: 42 })?.theme).toBeUndefined()
    expect(sanitizeSync({ ...validBase, theme: null })?.theme).toBeUndefined()
  })
  test('theme longer than 128 chars omitted', () => {
    expect(sanitizeSync({ ...validBase, theme: 'a'.repeat(129) })?.theme).toBeUndefined()
  })
  test('valid named color preserved', () => {
    expect(sanitizeSync({ ...validBase, theme: 'blue' })?.theme).toBe('blue')
  })
  test('valid hex color preserved', () => {
    expect(sanitizeSync({ ...validBase, theme: '#0b84ff' })?.theme).toBe('#0b84ff')
  })
})

// Task 55：design 字段（对齐 Codex sync A.5，全可选向后兼容）
describe('sanitizeSync - design 字段', () => {
  test('activeDesignChange 透传（对象）', () => {
    // brief 中 anchor:{...} 为占位简写（{...} 在字面量位置非合法 JS），此处替换为等价具体对象
    const dc = { id: 'dc1', anchor: { x: 1 }, declarations: [] }
    const r = sanitizeSync({ ...validBase, mode: 'comment', activeDesignChange: dc })
    expect(r?.activeDesignChange).toEqual(dc)
  })
  test('activeDesignChange 非 object 省略', () => {
    expect(sanitizeSync({ ...validBase, activeDesignChange: 'x' })?.activeDesignChange).toBeUndefined()
  })
  test('boolean design 字段默认/透传', () => {
    expect(sanitizeSync({ ...validBase, isDesignModifierPressed: true, canUseTweaks: true })?.isDesignModifierPressed).toBe(true)
    expect(sanitizeSync(validBase)?.isDesignModifierPressed).toBeUndefined()
    expect(sanitizeSync({ ...validBase, canUseTweaks: true })?.canUseTweaks).toBe(true)
  })
  test('isOriginalViewEnabled / isTweaksEditorOpen 透传', () => {
    expect(sanitizeSync({ ...validBase, isOriginalViewEnabled: true, isTweaksEditorOpen: false })?.isOriginalViewEnabled).toBe(true)
  })
})
