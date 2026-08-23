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
import type { SettingsBroker } from './settings/settings-broker'

const DEFAULT_SETTINGS: VoiceDictationSettings = {
  appId: '',
  accessToken: '',
  resourceId: '',
  language: '',
  customHotwords: '',
  outputMode: 'lume-input',
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
  }
}

export function updateVoiceDictationSettings(
  broker: SettingsBroker,
  updates: VoiceDictationSettingsUpdate,
): VoiceDictationSettings {
  const current = readVoiceDictationSettings(broker)
  const next: VoiceDictationSettings = {
    ...current,
    ...updates,
    outputMode: coerceOutputMode(updates.outputMode ?? current.outputMode),
  }
  broker.mutate((prev) => ({ ...prev, voiceDictation: next }))
  return next
}
