import type { ReadingAdvancedModelSettings, ReadingSettings, ReadingUpdateSettingsInput } from '@lume/shared'

export interface ReadingSettingsDraft {
  cadence: ReadingSettings['cadence']
  quiet: boolean
  maxDeepNotesPerWeek: number
  textModelMode: ReadingSettings['textModelMode']
  textModelRef: string
  imageModelRef: string
  advanced: ReadingAdvancedModelSettings
}

export const READING_CADENCE_OPTIONS: Array<{
  id: ReadingSettings['cadence']
  label: string
}> = [
  { id: 'weekly', label: '每周' },
  { id: 'few_times_weekly', label: '每周几次' },
  { id: 'manual', label: '手动' },
  { id: 'off', label: '关闭' },
]

export const READING_ADVANCED_STAGE_OPTIONS: Array<{
  id: keyof ReadingAdvancedModelSettings
  label: string
}> = [
  { id: 'selectionModelRef', label: '选书' },
  { id: 'seedModelRef', label: '种子札记' },
  { id: 'deepModelRef', label: '深度笔记' },
  { id: 'companionModelRef', label: '聊天陪读' },
]

export function getReadingSettingsDraft(settings: ReadingSettings): ReadingSettingsDraft {
  return {
    cadence: settings.cadence,
    quiet: settings.quiet,
    maxDeepNotesPerWeek: settings.maxDeepNotesPerWeek,
    textModelMode: settings.textModelMode,
    textModelRef: settings.textModelRef ?? '',
    imageModelRef: settings.imageModelRef ?? '',
    advanced: { ...settings.advanced },
  }
}

export function buildReadingSettingsSavePayload(draft: ReadingSettingsDraft): ReadingUpdateSettingsInput {
  const textModelRef = draft.textModelRef.trim()
  const imageModelRef = draft.imageModelRef.trim()
  return {
    cadence: draft.cadence,
    quiet: draft.quiet,
    maxDeepNotesPerWeek: Math.max(1, Math.min(4, Math.round(draft.maxDeepNotesPerWeek))),
    textModelMode: draft.textModelMode,
    textModelRef: draft.textModelMode === 'explicit' && textModelRef ? textModelRef : null,
    imageModelRef: imageModelRef || null,
    advanced: {
      selectionModelRef: trimOrUndefined(draft.advanced.selectionModelRef),
      seedModelRef: trimOrUndefined(draft.advanced.seedModelRef),
      deepModelRef: trimOrUndefined(draft.advanced.deepModelRef),
      companionModelRef: trimOrUndefined(draft.advanced.companionModelRef),
    },
  }
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
