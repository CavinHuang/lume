import { buildConnectionModelRef, isChannelViewReady, type Channel, type ReadingAdvancedModelSettings, type ReadingSettings, type ReadingUpdateSettingsInput } from '@lume/shared'

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

export interface ReadingModelOption {
  modelRef: string
  legacyModelRefs?: string[]
  label: string
}

const INHERIT_OPTION: ReadingModelOption = {
  modelRef: '',
  label: '继承默认模型',
}

export function buildReadingChatModelOptions(channels: Channel[]): ReadingModelOption[] {
  const models = channels
    .filter(isChannelViewReady)
    .flatMap((channel) =>
      channel.models
        .filter((model) => model.enabled && model.capabilities?.chat !== false)
        .map((model) => ({
          modelRef: buildConnectionModelRef(channel.id, model.id),
          legacyModelRefs: [
            model.id,
            `${channel.providerId || channel.provider}/${model.id}`,
            `${channel.id}/${model.id}`,
          ],
          label: `${model.name || model.id} · ${channel.name}`,
        }))
    )
  return [INHERIT_OPTION, ...models]
}

export function resolveReadingModelSelectValue(draft: ReadingSettingsDraft): string {
  if (draft.textModelMode === 'inherit') return ''
  return draft.textModelRef.trim()
}

export function applyReadingModelSelectChange(
  draft: ReadingSettingsDraft,
  selectedValue: string
): ReadingSettingsDraft {
  if (!selectedValue) {
    return { ...draft, textModelMode: 'inherit', textModelRef: '' }
  }
  return { ...draft, textModelMode: 'explicit', textModelRef: selectedValue }
}

export type ReadingModelField = 'text' | 'image' | keyof ReadingAdvancedModelSettings

/**
 * 构造单字段模型变更的增量 patch（updateReadingSettings 是 patch 语义，无需回填非模型字段）。
 * text/image 清除用 null；advanced 阶段清除用空字符串 "" ——
 * undefined 会被 JSON 序列化丢弃，sidecar 收不到字段就清不掉。
 */
export function buildReadingModelPatch(
  field: ReadingModelField,
  modelRef: string,
): ReadingUpdateSettingsInput {
  if (field === 'text') {
    const trimmed = modelRef.trim()
    return trimmed
      ? { textModelMode: 'explicit', textModelRef: trimmed }
      : { textModelMode: 'inherit', textModelRef: null }
  }
  if (field === 'image') {
    return { imageModelRef: modelRef.trim() || null }
  }
  return { advanced: buildAdvancedStagePatch(field, modelRef) }
}

function buildAdvancedStagePatch(
  field: keyof ReadingAdvancedModelSettings,
  modelRef: string,
): Partial<ReadingAdvancedModelSettings> {
  const trimmed = modelRef.trim()
  const patch: Partial<ReadingAdvancedModelSettings> = {}
  ;(patch as Record<string, unknown>)[field] = trimmed || ''
  return patch
}
