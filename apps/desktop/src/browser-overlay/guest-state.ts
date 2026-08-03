import { ipcRenderer } from 'electron'

export type AnchorKind = 'element' | 'text' | 'region'
export type GuestComment = Record<string, unknown> // 上层按需读取 anchor/body/id

export type GuestState = {
  tabId: string
  generation: number
  threadId: string
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  theme?: string
  comments: GuestComment[]
  activeDraft?: Record<string, unknown>
  // 新增 design 字段（对齐 Codex sync A.5）
  isDesignModifierPressed?: boolean
  canUseTweaks?: boolean
  isOriginalViewEnabled?: boolean
  isTweaksEditorOpen?: boolean
  activeDesignChange?: Record<string, unknown>
}

export type GuestBridge = {
  getState: () => GuestState | null
  send: (payload: Record<string, unknown>) => void
  subscribe: (listener: (state: GuestState | null) => void) => () => void
}

// 校验主进程发来的 sync/restore 消息，失败返回 null（消息来源不可信）
export function sanitizeSync(raw: unknown): GuestState | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.type !== 'sync' && m.type !== 'restore') return null
  if (typeof m.tabId !== 'string' || m.tabId.length < 1 || m.tabId.length > 256) return null
  if (typeof m.generation !== 'number' || !Number.isInteger(m.generation) || m.generation < 1 || m.generation > 2_000_000) return null
  if (typeof m.threadId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(m.threadId)) return null
  const theme = typeof m.theme === 'string' && m.theme.length <= 128 && (typeof CSS === 'undefined' || CSS.supports('color', m.theme)) ? m.theme : undefined
  return {
    tabId: m.tabId,
    generation: m.generation,
    threadId: m.threadId,
    mode: m.mode === 'comment' ? 'comment' : 'browse',
    purpose: m.purpose === 'tweaks' ? 'tweaks' : 'annotation',
    ...(theme ? { theme } : {}),
    comments: Array.isArray(m.comments) ? m.comments.slice(0, 100).filter((c): c is GuestComment => Boolean(c && typeof c === 'object')) : [],
    ...(m.activeDraft && typeof m.activeDraft === 'object' ? { activeDraft: m.activeDraft as GuestComment } : {}),
    ...(typeof m.isDesignModifierPressed === 'boolean' ? { isDesignModifierPressed: m.isDesignModifierPressed } : {}),
    ...(typeof m.canUseTweaks === 'boolean' ? { canUseTweaks: m.canUseTweaks } : {}),
    ...(typeof m.isOriginalViewEnabled === 'boolean' ? { isOriginalViewEnabled: m.isOriginalViewEnabled } : {}),
    ...(typeof m.isTweaksEditorOpen === 'boolean' ? { isTweaksEditorOpen: m.isTweaksEditorOpen } : {}),
    ...(isRecord(m.activeDesignChange) ? { activeDesignChange: m.activeDesignChange } : {}),
  }
}

// 封装 ipcRenderer：监听 lume:browser-annotation-guest，清洗后通知 listener；提供 send 回发主进程
export function createGuestBridge(initialListener?: (state: GuestState | null) => void): GuestBridge {
  let state: GuestState | null = null
  const listeners = new Set<(state: GuestState | null) => void>()
  if (initialListener) listeners.add(initialListener)

  const handler = (_e: Electron.IpcRendererEvent, raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    if (m.type === 'close') { state = null; listeners.forEach((l) => l(null)); return }
    const next = sanitizeSync(raw)
    if (!next) return
    state = next
    listeners.forEach((l) => l(next))
  }
  ipcRenderer.on('lume:browser-annotation-guest', handler)

  return {
    getState: () => state,
    send: (payload) => {
      if (!state || JSON.stringify(payload).length > 1_000_000) return
      ipcRenderer.send('lume:browser-annotation-guest', { ...payload, tabId: state.tabId, generation: state.generation, threadId: state.threadId })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (state) queueMicrotask(() => listener(state))
      return () => listeners.delete(listener)
    },
  }
}

// 纯对象判定（排除数组/null），与 manager.ts isRecord 语义一致
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
