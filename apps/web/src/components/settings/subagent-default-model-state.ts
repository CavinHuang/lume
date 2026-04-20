import type {
  Channel,
  LumeConfigSubagentModelStrategy,
} from '@lume/shared'
import {
  buildModelOptions,
  getEnabledChannels,
} from './model-option-utils'

export interface SubagentDefaultModelDraft {
  defaultModelRef?: string
  hasExplicitDefaultModel: boolean
  unavailableDefaultModelRef?: string
}

export function getSubagentDefaultModelDraft(input: {
  channels: Channel[]
  strategy?: LumeConfigSubagentModelStrategy
}): SubagentDefaultModelDraft {
  const enabledChannels = getEnabledChannels(input.channels)
  const modelOptions = buildModelOptions(enabledChannels)
  const configuredModelRef = input.strategy?.defaultModelRef?.trim() || undefined

  return {
    defaultModelRef: modelOptions.some((option) => option.modelRef === configuredModelRef)
      ? configuredModelRef
      : undefined,
    hasExplicitDefaultModel: Boolean(configuredModelRef),
    unavailableDefaultModelRef:
      configuredModelRef && !modelOptions.some((option) => option.modelRef === configuredModelRef)
        ? configuredModelRef
        : undefined,
  }
}

export function buildSubagentDefaultModelPayload(
  draft: SubagentDefaultModelDraft
): LumeConfigSubagentModelStrategy {
  const defaultModelRef = draft.defaultModelRef?.trim()
  return draft.hasExplicitDefaultModel && defaultModelRef
    ? { defaultModelRef }
    : {}
}

export function hasSubagentDraftChanges(input: {
  persistedStrategy?: LumeConfigSubagentModelStrategy
  draft: SubagentDefaultModelDraft
}): boolean {
  return JSON.stringify(input.persistedStrategy ?? {})
    !== JSON.stringify(buildSubagentDefaultModelPayload(input.draft))
}
