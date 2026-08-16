import { GENERAL_SETTINGS_DEFAULTS, type ChatFontScale } from '@lume/shared'

const CHAT_FONT_SCALE_STORAGE_KEY = 'lume:chat-font-scale'

export function isChatFontScale(value: unknown): value is ChatFontScale {
  return value === 'sm' || value === 'md' || value === 'lg'
}

export function setChatFontScale(scale: ChatFontScale): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CHAT_FONT_SCALE_STORAGE_KEY, scale)
  }
  if (typeof document === 'undefined') return
  // md 是默认档：不落 data 属性，CSS :root 基础值即 md
  if (scale === 'md') {
    delete document.documentElement.dataset.chatFontScale
  } else {
    document.documentElement.dataset.chatFontScale = scale
  }
}

export function readStoredChatFontScale(): ChatFontScale {
  if (typeof window === 'undefined') {
    return GENERAL_SETTINGS_DEFAULTS.chatFontScale
  }
  const value = window.localStorage.getItem(CHAT_FONT_SCALE_STORAGE_KEY)
  return isChatFontScale(value) ? value : GENERAL_SETTINGS_DEFAULTS.chatFontScale
}
