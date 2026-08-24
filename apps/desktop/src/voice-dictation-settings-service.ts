/**
 * 语音输入设置读写：settings.json 的 `voiceDictation` 键。
 *
 * 凭证（accessToken）以明文存于本地 settings.json，与其他渠道凭证的落盘位置一致；
 * 读取时对字段做形状校验，缺省字段回退默认值。
 */

import type {
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
} from '@lume/shared'
import { VOICE_DICTATION_DEFAULT_SHORTCUT } from '@lume/shared'
import type { SettingsBroker } from './settings/settings-broker'

const DEFAULT_SETTINGS: VoiceDictationSettings = {
  appId: '',
  accessToken: '',
  resourceId: '',
  language: '',
  customHotwords: '',
  outputMode: 'lume-input',
  shortcut: VOICE_DICTATION_DEFAULT_SHORTCUT,
}

type PersistedShape = Partial<Record<keyof VoiceDictationSettings, unknown>>

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

const VALID_OUTPUT_MODES = new Set(['lume-input', 'clipboard', 'system-cursor'])

function coerceOutputMode(value: unknown): VoiceDictationSettings['outputMode'] {
  return typeof value === 'string' && VALID_OUTPUT_MODES.has(value)
    ? value as VoiceDictationSettings['outputMode']
    : 'lume-input'
}

export function readVoiceDictationSettings(broker: SettingsBroker): VoiceDictationSettings {
  const raw = broker.read().voiceDictation as PersistedShape | undefined
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  return {
    appId: coerceString(raw.appId, DEFAULT_SETTINGS.appId),
    accessToken: coerceString(raw.accessToken, DEFAULT_SETTINGS.accessToken),
    resourceId: coerceString(raw.resourceId, DEFAULT_SETTINGS.resourceId),
    language: coerceString(raw.language, DEFAULT_SETTINGS.language),
    customHotwords: coerceString(raw.customHotwords, DEFAULT_SETTINGS.customHotwords),
    outputMode: coerceOutputMode(raw.outputMode),
    shortcut: coerceString(raw.shortcut, DEFAULT_SETTINGS.shortcut) || VOICE_DICTATION_DEFAULT_SHORTCUT,
  }
}

/** 快捷键同步决策：副作用（globalShortcut/broker 写）由调用方按 action 执行。 */
export type VoiceShortcutSyncPlan =
  | { action: 'keep'; shortcut: string }
  | { action: 'unregister' }
  | { action: 'register'; shortcut: string }

/**
 * 全局快捷键同步的三态决策（纯函数，单测钉死转移表）：
 * - 凭证不齐全：不应占用系统按键——有残留则解绑，否则保持；
 * - 齐全且已注册同键：保持；
 * - 齐全且键不同/未注册：注册目标键。
 */
export function planVoiceShortcutSync(params: {
  credentialsComplete: boolean
  desiredShortcut: string
  currentRegisteredShortcut: string
}): VoiceShortcutSyncPlan {
  if (!params.credentialsComplete) {
    return params.currentRegisteredShortcut
      ? { action: 'unregister' }
      : { action: 'keep', shortcut: params.desiredShortcut }
  }
  if (params.currentRegisteredShortcut === params.desiredShortcut) {
    return { action: 'keep', shortcut: params.desiredShortcut }
  }
  return { action: 'register', shortcut: params.desiredShortcut }
}

export function updateVoiceDictationSettings(
  broker: SettingsBroker,
  updates: VoiceDictationSettingsUpdate,
): VoiceDictationSettings {
  const current = readVoiceDictationSettings(broker)
  // IPC payload 不经校验直接展开会把非 string 脏值落盘，下次读取被 coerce
  // 静默清空（凭证无声丢失）——逐字段类型收敛后再合并。
  const next: VoiceDictationSettings = {
    appId: coerceString(updates.appId, current.appId),
    accessToken: coerceString(updates.accessToken, current.accessToken),
    resourceId: coerceString(updates.resourceId, current.resourceId),
    language: coerceString(updates.language, current.language),
    customHotwords: coerceString(updates.customHotwords, current.customHotwords),
    outputMode: coerceOutputMode(updates.outputMode ?? current.outputMode),
    shortcut: (typeof updates.shortcut === 'string' && updates.shortcut.trim())
      ? updates.shortcut.trim()
      : current.shortcut,
  }
  broker.mutate((prev) => ({ ...prev, voiceDictation: next }))
  return next
}
